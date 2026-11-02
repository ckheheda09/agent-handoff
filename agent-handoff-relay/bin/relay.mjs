#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Store, must } from '../src/store.mjs';
import { createRelay } from '../src/server.mjs';
import { createAdmin } from '../src/admin.mjs';

process.umask(0o077);
const [command, sub, ...rest] = process.argv.slice(2);
function parse(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    must(args[i]?.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'), 400, 'expected_flag_and_value');
    must(!(args[i].slice(2) in result), 400, 'duplicate_option'); result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}
function integer(value, fallback) {
  if (value === undefined) return fallback;
  must(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)), 400, 'invalid_numeric_option'); return Number(value);
}
function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
async function main() {
  const options = parse(command === 'device' ? rest : [sub, ...rest].filter(x => x !== undefined));
  const data = options.data ?? process.env.RELAY_DATA_DIR;
  must(data, 400, 'data_directory_required');
  if (command === 'serve') {
    must(Number(process.versions.node.split('.')[0]) === 24, 500, 'node_24_required');
    const port = integer(options.port ?? process.env.RELAY_PORT, 17860); must(port <= 65535, 400, 'invalid_port');
    const relay = createRelay({ data, quota: integer(process.env.RELAY_QUOTA_BYTES, 10 * 1024 ** 3),
      maxPayload: integer(process.env.RELAY_MAX_PAYLOAD_BYTES, 1024 ** 3),
      ttl: integer(process.env.RELAY_TTL_DAYS, 30) * 86400_000,
      log: value => process.stdout.write(JSON.stringify(value) + '\n') });
    let admin;
    if (process.env.RELAY_ADMIN_CREDENTIAL_FILE) {
      admin = createAdmin(relay, { credentialFile: process.env.RELAY_ADMIN_CREDENTIAL_FILE,
        origin: process.env.RELAY_ADMIN_ORIGIN, relayURL: process.env.RELAY_PUBLIC_URL });
      admin.server.once('error', () => { process.stderr.write('admin_listen_failed\n'); process.kill(process.pid, 'SIGTERM'); });
      admin.server.listen(integer(process.env.RELAY_ADMIN_PORT, 17863), '127.0.0.1');
    }
    relay.server.once('error', async () => { await relay.close(); process.stderr.write('listen_failed\n'); process.exitCode = 1; });
    relay.server.listen(port, '127.0.0.1', () => output({ status: 'listening', address: '127.0.0.1', port }));
    let maintenance = Promise.resolve();
    const interval = setInterval(() => {
      maintenance = maintenance.then(() => relay.sweep()).catch(() => process.stderr.write('maintenance_failed\n'));
    }, 60_000); interval.unref();
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true; clearInterval(interval);
      const timeout = setTimeout(() => { relay.server.closeAllConnections(); admin?.server.closeAllConnections(); }, 15_000); timeout.unref();
      await maintenance; await admin?.close(); await relay.close(); clearTimeout(timeout);
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop); return;
  }
  const store = new Store(data);
  try {
    if (command === 'init') return output({ status: 'initialized', data: store.root });
    if (command === 'stats') return output(store.stats());
    if (command === 'backup') {
      must(options.out && !fs.existsSync(options.out), 409, 'new_backup_path_required');
      await store.backupTo(path.resolve(options.out)); return output({ status: 'database_backed_up', path: path.resolve(options.out) });
    }
    if (command === 'device' && sub === 'delete') { const result = store.deleteDevice(options.id); return output(result.audit); }
    if (command === 'device' && sub === 'revoke') { store.revokeDevice(options.id); return output({ status: 'revoked', id: options.id }); }
    if (command === 'device' && ['add', 'rotate'].includes(sub)) {
      must(options.out && options.url, 400, 'out_and_url_required');
      const url = new URL(options.url);
      must(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 400, 'https_origin_required');
      const file = path.resolve(options.out); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        const token = sub === 'add' ? store.addDevice(options.id, options.name ?? options.id) : store.rotateDevice(options.id);
        fs.writeFileSync(fd, JSON.stringify({ credential_version: 1, device_id: options.id, relay_url: url.origin, token }, null, 2) + '\n'); fs.fsyncSync(fd);
      } catch (e) { fs.closeSync(fd); fs.rmSync(file, { force: true }); throw e; }
      fs.closeSync(fd); return output({ status: 'credential_written', id: options.id, path: file, secret_printed: false });
    }
    throw new Error('unknown_command');
  } finally { store.close(); }
}
main().catch(e => { process.stderr.write(JSON.stringify({ error: e.code ?? e.message }) + '\n'); process.exitCode = 1; });
