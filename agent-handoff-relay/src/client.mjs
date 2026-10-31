import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AGE_MAGIC, Fault, must } from './store.mjs';

export function readCredentials(file, allowHTTP = false, tunnelURL) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8')); const url = new URL(c.relay_url);
  must(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 400, 'invalid_relay_url');
  must(url.protocol === 'https:' || (allowHTTP && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 400, 'https_required');
  must(typeof c.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c.token), 400, 'invalid_credentials');
  if (tunnelURL) {
    const tunnel = new URL(tunnelURL);
    must(tunnel.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(tunnel.hostname) &&
      tunnel.pathname === '/' && !tunnel.username && !tunnel.password && !tunnel.search && !tunnel.hash, 400, 'loopback_tunnel_required');
    return { ...c, relay_url: tunnel.origin };
  }
  return { ...c, relay_url: url.origin };
}
export function makeClient(credentials) {
  const base = credentials.relay_url;
  async function request(route, options = {}) {
    const response = await fetch(`${base}${route}`, { ...options, redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${credentials.token}`, ...options.headers } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Fault(response.status, body.error ?? `http_${response.status}`);
    }
    return response;
  }
  async function json(route, method = 'GET', body) {
    return (await request(route, { method, ...(body !== undefined ? {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : {}) })).json();
  }
  async function shaFile(file) {
    const hash = createHash('sha256'); for await (const part of fs.createReadStream(file)) hash.update(part); return hash.digest('hex');
  }
  return {
    request, json,
    async send({ file, to, id = randomUUID(), adapter = 'generic', profile = 'default', onProgress = () => {} }) {
      const info = fs.lstatSync(file); must(info.isFile() && !info.isSymbolicLink(), 400, 'regular_file_required');
      const handle = fs.openSync(file, 'r'); const magic = Buffer.alloc(AGE_MAGIC.length);
      try { fs.readSync(handle, magic, 0, magic.length, 0); } finally { fs.closeSync(handle); }
      must(magic.equals(AGE_MAGIC), 400, 'encrypt_with_binary_age_first');
      const sha = await shaFile(file);
      let state = await json('/v1/handoffs', 'POST', { id, recipient: to, size: info.size, sha256: sha,
        payload_format: 'age-v1', adapter_id: adapter, profile_id: profile });
      must(['uploading', 'ready'].includes(state.status), 409, 'handoff_not_resumable');
      onProgress({ id, offset: state.offset, size: info.size });
      if (state.status === 'ready') return state;
      const me = await json('/v1/me'); const chunkSize = Math.min(me.max_chunk_bytes, 8 * 1024 ** 2);
      const source = await fs.promises.open(file, 'r');
      try {
        while (state.offset < info.size) {
          const amount = Math.min(chunkSize, info.size - state.offset); const bytes = Buffer.alloc(amount);
          let read = 0;
          while (read < amount) {
            const r = await source.read(bytes, read, amount - read, state.offset + read);
            must(r.bytesRead > 0, 409, 'source_file_changed'); read += r.bytesRead;
          }
          state = { ...state, ...await (await request(`/v1/handoffs/${id}/payload`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(state.offset) }, body: bytes
          })).json() };
          onProgress({ id, offset: state.offset, size: info.size });
        }
      } finally { await source.close(); }
      return json(`/v1/handoffs/${id}/commit`, 'POST', {});
    },
    async download({ id, out }) {
      const state = await json(`/v1/handoffs/${encodeURIComponent(id)}`);
      must(state.status === 'ready', 409, 'payload_not_ready');
      const final = path.resolve(out); const partial = `${final}.part`;
      if (fs.existsSync(final)) {
        const info = fs.lstatSync(final); must(info.isFile() && !info.isSymbolicLink(), 409, 'output_not_regular');
        must(info.size === state.size && await shaFile(final) === state.sha256, 409, 'output_already_exists');
        return { id, path: final, sha256: state.sha256, bytes_verified: true };
      }
      fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
      let offset = 0;
      const hasPartial = fs.existsSync(partial);
      if (hasPartial) {
        const info = fs.lstatSync(partial); must(info.isFile() && !info.isSymbolicLink(), 409, 'partial_not_regular');
        offset = info.size; must(offset <= state.size, 409, 'partial_too_large');
      }
      if (offset < state.size) {
        const response = await request(`/v1/handoffs/${encodeURIComponent(id)}/payload`, {
          // A 1 GiB package needs about 29 minutes at the target server's 5 Mbps.
          signal: AbortSignal.timeout(3_600_000),
          headers: offset ? { Range: `bytes=${offset}-` } : {}
        });
        must(response.status === (offset ? 206 : 200), 409, 'unexpected_range_response');
        must(response.headers.get('x-payload-sha256') === state.sha256, 409, 'payload_identity_changed');
        if (offset) must(response.headers.get('content-range') === `bytes ${offset}-${state.size - 1}/${state.size}`, 409, 'unexpected_content_range');
        const handle = await fs.promises.open(partial, hasPartial ? 'r+' : 'wx', 0o600);
        try {
          for await (const chunk of response.body) {
            must(offset + chunk.length <= state.size, 409, 'download_exceeds_declared_size');
            let written = 0;
            while (written < chunk.length) {
              const result = await handle.write(chunk, written, chunk.length - written, offset + written);
              written += result.bytesWritten;
            }
            offset += chunk.length;
          }
          await handle.sync();
        } finally { await handle.close(); }
      }
      must(offset === state.size && await shaFile(partial) === state.sha256, 422, 'download_checksum_mismatch');
      // Exclusive link avoids replacing an existing output created by another process.
      await fs.promises.link(partial, final); await fs.promises.unlink(partial);
      return { id, path: final, sha256: state.sha256, bytes_verified: true };
    }
  };
}
