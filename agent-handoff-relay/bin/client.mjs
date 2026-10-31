#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readCredentials, makeClient } from '../src/client.mjs';
import { must, Fault } from '../src/store.mjs';

process.umask(0o077);
const [command, ...args] = process.argv.slice(2); const options = {};
async function main() {
  for (let i = 0; i < args.length; i += 2) {
    must(args[i]?.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'), 400, 'expected_flag_and_value');
    must(!(args[i].slice(2) in options), 400, 'duplicate_option'); options[args[i].slice(2)] = args[i + 1];
  }
  must(options.credentials, 400, 'credentials_file_required');
  const client = makeClient(readCredentials(options.credentials, options['allow-local-http'] === 'true', options['tunnel-url'])); let result;
  if (command === 'whoami') result = await client.json('/v1/me');
  else if (command === 'heartbeat') {
    must(options.adapter, 400, 'adapter_required');
    result = await client.json('/v1/agents/heartbeat', 'POST', { adapter_id: options.adapter,
      profile_id: options.profile ?? 'default', name: options.name ?? options.adapter, version: options.version ?? '' });
  }
  else if (command === 'inbox' || command === 'outbox') result = await client.json(`/v1/${command}?after=${encodeURIComponent(options.after ?? '0')}`);
  else if (command === 'status') result = await client.json(`/v1/handoffs/${encodeURIComponent(options.id)}`);
  else if (command === 'cancel') result = await client.json(`/v1/handoffs/${encodeURIComponent(options.id)}`, 'DELETE');
  else if (command === 'send') {
    must(options.file && options.to && options.id, 400, 'file_to_and_stable_id_required');
    result = await client.send({ file: options.file, to: options.to, id: options.id,
      adapter: options.adapter ?? 'generic', profile: options.profile ?? 'default',
      onProgress: p => process.stderr.write(JSON.stringify(p) + '\n') });
  } else if (command === 'download') {
    must(options.id && options.out, 400, 'id_and_out_required'); result = await client.download({ id: options.id, out: options.out });
  } else if (command === 'receipt') {
    must(options.id && options.state && options['request-id'], 400, 'id_state_and_stable_request_id_required');
    result = await client.json(`/v1/handoffs/${encodeURIComponent(options.id)}/receipts`, 'POST', {
      request_id: options['request-id'], state: options.state, code: options.code ?? '' });
  } else throw new Error('unknown_command');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(e => { process.stderr.write(JSON.stringify({ error: e instanceof Fault ? e.code : (e.code ?? 'client_error'), status: e.status }) + '\n'); process.exitCode = 1; });
