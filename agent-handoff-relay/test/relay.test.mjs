import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelay, CHUNK } from '../src/server.mjs';
import { AGE_MAGIC, digest, Store } from '../src/store.mjs';
import { makeClient, readCredentials } from '../src/client.mjs';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Transport fixtures intentionally are not cryptographically valid age files.
// The relay checks framing and ciphertext hashes; real decryption is a client responsibility.
const payload = (text = 'synthetic-ciphertext') => Buffer.concat([AGE_MAGIC, Buffer.from(text)]);

test('shared catalog persists, shows pending access without ciphertext, checks readers/hash/quota, and revocation blocks access',async t=>{
  const f=await fixture(t);const bytes=payload('shared-summary');
  // Synthetic directory and ciphertext fixtures; real age coverage is in the client suite.
  const key='age1ql3z7hjy54pw3hyww5mhv5l2njggjqxh7k6vj7l2wqgmy8qz7wzss0e72w';
  // The API validates the supplied reader list against the directory, not the age stanzas.
  for(const id of ['a','b'])f.app.store.db.prepare('INSERT INTO device_encryption_keys VALUES(?,?,?)').run(id,key,Date.now());
  const data={id:'catalog-one',title:'继续部署',source_agent:'hermes',readers:['a','b'].map(device_id=>({device_id,recipient:key})),payload:bytes.toString('base64'),sha256:digest(bytes)};
  assert.equal((await f.json(null,'/v1/sessions')).status,401);
  assert.equal((await f.json('a','/v1/sessions','POST',data)).status,200);
  assert.equal((await f.json('a','/v1/sessions','POST',data)).status,200);
  assert.equal((await f.json('a','/v1/sessions','POST',{...data,title:'changed'})).status,409);
  const listed=await f.json('b','/v1/sessions');assert.equal(listed.body.items[0].title,data.title);assert(!JSON.stringify(listed.body).includes(data.payload));
  assert.equal((await f.json('c','/v1/sessions')).body.items[0].access_state,'waiting_source_sync');
  assert.equal((await f.json('c','/v1/sessions/catalog-one/payload')).body.error,'session_sync_required');
  assert.equal((await f.json('b','/v1/sessions/catalog-one/received','POST',{})).body.state,'received');
  await f.restart();assert.equal((await f.json('b','/v1/sessions')).body.items[0].receive_state,'received');
  assert.equal((await f.json('a','/v1/sessions')).body.items[0].receive_state,'available');
  assert.equal((await f.json('b','/v1/sessions/catalog-one/payload')).body.payload,data.payload);
  assert.equal((await f.json('a','/v1/sessions','POST',{...data,id:'bad-hash',sha256:'0'.repeat(64)})).status,422);
  assert.equal((await f.json('a','/v1/sessions','POST',{...data,id:'bad-readers',readers:[...data.readers,{device_id:'c',recipient:key}]})).status,409);
  f.app.store.quota=bytes.length;assert.equal((await f.json('a','/v1/sessions','POST',{...data,id:'over-quota'})).status,507);
  assert.equal((await f.create('direct-quota',bytes)).status,507);
  f.app.store.revokeDevice('b');assert.equal((await f.json('b','/v1/sessions/catalog-one/payload')).status,401);
  await f.app.sweep(Date.now()+31*86400_000);assert.equal((await f.json('a','/v1/sessions')).body.items.length,0);
  assert.equal(f.app.store.stats().reserved_bytes,0);
});
test('sender sync adds later devices, preserves independent receipts and retries, rejects stale/unauthorized updates',async t=>{
  const f=await fixture(t),key='age1ql3z7hjy54pw3hyww5mhv5l2njggjqxh7k6vj7l2wqgmy8qz7wzss0e72w';
  for(const id of ['a','b','c'])f.app.store.db.prepare('INSERT INTO device_encryption_keys VALUES(?,?,?)').run(id,key,Date.now());
  const bytes=payload('original'),data={id:'sync-one',title:'跨设备会话',source_agent:'hermes',readers:['a','b'].map(device_id=>({device_id,recipient:key})),payload:bytes.toString('base64'),sha256:digest(bytes)};
  const before=(await f.json('a','/v1/sessions','POST',data)).body;
  await f.json('b','/v1/sessions/sync-one/received','POST',{});
  assert.equal((await f.json('c','/v1/sessions/sync-one/received','POST',{})).body.error,'session_sync_required');
  assert.equal((await f.json('c','/v1/sessions')).body.items[0].readable,false);
  const replacement=payload('updated ciphertext for all three devices');
  const update={previous_sha256:before.sha256,readers:['a','b','c'].map(device_id=>({device_id,recipient:key})),payload:replacement.toString('base64'),sha256:digest(replacement)};
  assert.equal((await f.json('b','/v1/sessions/sync-one/readers','POST',update)).body.error,'session_sender_only');
  assert.equal((await f.json('a','/v1/sessions/sync-one/readers','POST',{...update,previous_sha256:'0'.repeat(64)})).body.error,'session_payload_changed');
  assert.equal((await f.json('a','/v1/sessions/sync-one/readers','POST',{...update,sha256:'0'.repeat(64)})).body.error,'checksum_mismatch');
  assert.equal((await f.json('a','/v1/sessions/sync-one/readers','POST',{...update,readers:update.readers.filter(r=>r.device_id!=='b')})).body.error,'session_reader_removed');
  assert.equal((await f.json('a','/v1/sessions/sync-one/readers','POST',{...update,readers:update.readers.map(r=>({...r,recipient:'changed'}))})).body.error,'session_reader_changed');
  f.app.store.quota=bytes.length;
  assert.equal((await f.json('a','/v1/sessions/sync-one/readers','POST',update)).status,507);
  assert.equal((await f.json('a','/v1/sessions/sync-one/payload')).body.payload,data.payload);
  f.app.store.quota=1024**3;
  const changed=await f.json('a','/v1/sessions/sync-one/readers','POST',update);assert.equal(changed.status,200);
  assert.equal(changed.body.created_at,before.created_at);assert.equal(changed.body.expires_at,before.expires_at);
  assert.equal((await f.json('a','/v1/sessions/sync-one/readers','POST',update)).status,200); // lost-response retry
  assert.equal((await f.json('a','/v1/sessions','POST',data)).body.sha256,update.sha256); // original publish retry cannot undo sync
  await f.restart();
  assert.equal((await f.json('b','/v1/sessions')).body.items[0].receive_state,'received');
  assert.equal((await f.json('c','/v1/sessions')).body.items[0].receive_state,'available');
  assert.equal((await f.json('c','/v1/sessions/sync-one/payload')).body.payload,update.payload);
  await f.json('c','/v1/sessions/sync-one/received','POST',{});
  assert.equal((await f.json('b','/v1/sessions/sync-one/payload')).body.payload,update.payload);
  assert.equal((await f.json('c','/v1/sessions/sync-one/payload')).body.payload,update.payload);
  assert.equal(f.app.store.reservedBytes(),replacement.length);
});

async function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-relay-test-'));
  let app = createRelay({ data: path.join(root, 'data'), ...config });
  const tokens = {};
  for (const id of ['a', 'b', 'c']) tokens[id] = app.store.addDevice(id, id);
  async function listen() {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  }
  await listen();
  const f = {
    root, tokens, get app() { return app; }, get base() { return `http://127.0.0.1:${app.server.address().port}`; },
    async restart() { await app.close(); app = createRelay({ data: path.join(root, 'data'), ...config }); await listen(); },
    async request(who, route, method = 'GET', body, headers = {}) {
      return fetch(f.base + route, { method, headers: { ...(who ? { Authorization: `Bearer ${tokens[who] ?? who}` } : {}), ...headers },
        ...(body === undefined ? {} : { body }) });
    },
    async json(who, route, method = 'GET', body) {
      const r = await f.request(who, route, method, body === undefined ? undefined : JSON.stringify(body),
        body === undefined ? {} : { 'Content-Type': 'application/json' });
      return { status: r.status, body: await r.json() };
    },
    async create(id, bytes, sender = 'a', recipient = 'b', overrides = {}) {
      return f.json(sender, '/v1/handoffs', 'POST', { id, recipient, size: bytes.length, sha256: digest(bytes), payload_format: 'age-v1', ...overrides });
    },
    async append(id, bytes, offset = 0, sender = 'a') {
      const r = await f.request(sender, `/v1/handoffs/${id}/payload`, 'PATCH', bytes,
        { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) });
      return { status: r.status, body: await r.json() };
    },
    async upload(id, bytes, sender = 'a', recipient = 'b') {
      assert.equal((await f.create(id, bytes, sender, recipient)).status, 201);
      assert.equal((await f.append(id, bytes, 0, sender)).status, 200);
      const r = await f.json(sender, `/v1/handoffs/${id}/commit`, 'POST', {}); assert.equal(r.status, 200); return r.body;
    }
  };
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }); return f;
}

test('public health; independent bearer authentication; no CORS', async t => {
  const f = await fixture(t);
  assert.equal((await f.json(null, '/healthz')).status, 200);
  assert.equal((await f.json(null, '/v1/inbox')).status, 401);
  assert.equal((await f.json('bad', '/v1/me')).status, 401);
  assert.equal((await f.json('a', '/v1/me')).body.device_id, 'a');
  const r = await f.request('a', '/v1/me'); assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('bidirectional payload round-trip, private inboxes, and recipient routing', async t => {
  const f = await fixture(t); const bytes = payload();
  await f.upload('forward', bytes);
  const inbox = await f.json('b', '/v1/inbox'); assert.deepEqual(inbox.body.items.map(x => x.id), ['forward']);
  assert.equal((await f.json('c', '/v1/inbox')).body.items.length, 0);
  for (const suffix of ['', '/payload']) assert.equal((await f.request('c', `/v1/handoffs/forward${suffix}`)).status, 404);
  const response = await f.request('b', '/v1/handoffs/forward/payload');
  assert.equal(response.headers.get('x-payload-sha256'), digest(bytes));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await f.upload('return-trip', payload('revised'), 'b', 'a');
  assert.deepEqual((await f.json('a', '/v1/inbox')).body.items.map(x => x.id), ['return-trip']);
});

test('idempotent creation and commit; conflicting metadata cannot overwrite', async t => {
  const f = await fixture(t); const bytes = payload();
  assert.equal((await f.create('stable', bytes)).status, 201);
  assert.equal((await f.create('stable', bytes)).status, 200);
  assert.equal((await f.create('stable', payload('different'))).status, 409);
  assert.equal((await f.create('stable', bytes, 'c')).status, 404);
  await f.append('stable', bytes);
  for (let i = 0; i < 2; i++) assert.equal((await f.json('a', '/v1/handoffs/stable/commit', 'POST', {})).status, 200);
  assert.equal((await f.json('b', '/v1/inbox')).body.items.length, 1);
});

test('upload cursor survives restart; unacknowledged file tail is truncated', async t => {
  const f = await fixture(t); const bytes = payload('a longer message'); const n = 7;
  await f.create('restart', bytes); await f.append('restart', bytes.subarray(0, n));
  fs.appendFileSync(f.app.store.payloadPath('restart'), 'unacknowledged-tail');
  await f.restart();
  assert.equal((await f.json('a', '/v1/handoffs/restart')).body.offset, n);
  assert.equal((await f.append('restart', bytes.subarray(n), n)).status, 200);
  assert.equal((await f.json('a', '/v1/handoffs/restart/commit', 'POST', {})).status, 200);
  assert.deepEqual(fs.readFileSync(f.app.store.payloadPath('restart')), bytes);
});

test('simultaneous chunks with the same offset append once', async t => {
  const f = await fixture(t); const bytes = payload(); await f.create('race', bytes);
  const results = await Promise.all([f.append('race', bytes), f.append('race', bytes)]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  assert.equal(fs.statSync(f.app.store.payloadPath('race')).size, bytes.length);
});

test('quota reserves declared bytes before upload and releases on cancellation', async t => {
  const f = await fixture(t, { quota: 100, maxPayload: 100 }); const bytes = payload('x'.repeat(45));
  assert.equal((await f.create('reserve-one', bytes)).status, 201);
  assert.equal((await f.create('reserve-two', bytes)).status, 507);
  assert.equal((await f.json('a', '/v1/handoffs/reserve-one', 'DELETE')).status, 200);
  assert.equal((await f.create('reserve-two', bytes)).status, 201);
});

test('plaintext and corrupted ciphertext cannot be published', async t => {
  const f = await fixture(t); const bytes = payload();
  await f.create('bad-hash', bytes); const wrong = Buffer.from(bytes); wrong[wrong.length - 1] ^= 1;
  await f.append('bad-hash', wrong);
  assert.equal((await f.json('a', '/v1/handoffs/bad-hash/commit', 'POST', {})).body.error, 'checksum_mismatch');
  const plain = Buffer.from('this is unencrypted plain conversation text');
  await f.create('plain', plain); await f.append('plain', plain);
  assert.equal((await f.json('a', '/v1/handoffs/plain/commit', 'POST', {})).body.error, 'age_header_required');
  assert.equal((await f.json('b', '/v1/inbox')).body.items.length, 0);
});

test('delivery cursor follows commit order, so slow uploads are not skipped', async t => {
  const f = await fixture(t); const bytes = payload();
  await f.create('slow', bytes); await f.upload('fast', bytes);
  const page = (await f.json('b', '/v1/inbox')).body;
  await f.append('slow', bytes); await f.json('a', '/v1/handoffs/slow/commit', 'POST', {});
  assert.deepEqual((await f.json('b', `/v1/inbox?after=${page.next_cursor}`)).body.items.map(x => x.id), ['slow']);
});

test('receipts enforce recipient identity, monotonic states and idempotency', async t => {
  const f = await fixture(t); await f.upload('receipt', payload());
  const route = '/v1/handoffs/receipt/receipts';
  assert.equal((await f.json('a', route, 'POST', { request_id: 'r0', state: 'verified' })).status, 403);
  assert.equal((await f.json('b', route, 'POST', { request_id: 'r0', state: 'completed' })).status, 409);
  for (const state of ['verified', 'accepted', 'started', 'completed']) {
    const body = { request_id: `r-${state}`, state };
    assert.equal((await f.json('b', route, 'POST', body)).status, 200);
    assert.equal((await f.json('b', route, 'POST', body)).status, 200);
  }
  assert.equal((await f.json('b', route, 'POST', { request_id: 'r-verified', state: 'failed' })).status, 409);
  assert.equal((await f.json('a', '/v1/handoffs/receipt', 'DELETE')).status, 409);
  assert.equal((await f.json('a', '/v1/handoffs/receipt')).body.receipts.length, 4);
});

test('range downloads are exact and invalid ranges are rejected', async t => {
  const f = await fixture(t); const bytes = payload(); await f.upload('range', bytes);
  const r = await f.request('b', '/v1/handoffs/range/payload', 'GET', undefined, { Range: 'bytes=3-8' });
  assert.equal(r.status, 206); assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(3, 9));
  assert.equal((await f.request('b', '/v1/handoffs/range/payload', 'GET', undefined, { Range: 'bytes=9999-' })).status, 416);
});

test('expiry cleans payload and quota but retains observable metadata', async t => {
  const f = await fixture(t); await f.upload('expired', payload());
  const time = f.app.store.get('expired').expires_at + 1; await f.app.sweep(time);
  assert.equal((await f.json('a', '/v1/handoffs/expired')).body.status, 'expired');
  assert.equal((await f.request('b', '/v1/handoffs/expired/payload')).status, 410);
  assert.equal(f.app.store.stats().reserved_bytes, 0);
});

test('revocation and credential rotation affect the running server immediately', async t => {
  const f = await fixture(t); f.app.store.revokeDevice('a');
  assert.equal((await f.json('a', '/v1/me')).status, 401);
  const old = f.tokens.a; f.tokens.a = f.app.store.rotateDevice('a');
  assert.equal((await f.json(old, '/v1/me')).status, 401);
  assert.equal((await f.json('a', '/v1/me')).status, 200);
});

test('metadata size, plaintext fields, identifiers and parser bounds are enforced', async t => {
  const f = await fixture(t); const bytes = payload();
  assert.equal((await f.create('../escape', bytes)).status, 400);
  assert.equal((await f.create('title', bytes, 'a', 'b', { title: 'private text' })).body.error, 'unknown_field');
  const bad = await f.request('a', '/v1/handoffs', 'POST', '{bad', { 'Content-Type': 'application/json' }); assert.equal(bad.status, 400);
  const large = await f.request('a', '/v1/handoffs', 'POST', 'x'.repeat(17000), { 'Content-Type': 'application/json' }); assert.equal(large.status, 413);
  assert.equal((await f.json('a', '/v1/inbox?limit=101')).status, 400);
});

test('consistent SQLite backup and single-server filesystem ownership', async t => {
  const f = await fixture(t); await f.upload('backup', payload());
  assert.throws(() => createRelay({ data: f.app.store.root }), /server_already_running/);
  const file = path.join(f.root, 'backup.db'); await f.app.store.backupTo(file);
  const other = path.join(f.root, 'restored'); fs.mkdirSync(other); fs.copyFileSync(file, path.join(other, 'relay.db'));
  const restored = new Store(other); try { assert.equal(restored.get('backup').status, 'ready'); } finally { restored.close(); }
});

test('client module sends and resumes downloads with verified byte hashes', async t => {
  const f = await fixture(t); const bytes = payload('x'.repeat(70000)); const file = path.join(f.root, 'payload.age'); fs.writeFileSync(file, bytes);
  const a = makeClient({ relay_url: f.base, token: f.tokens.a }); const b = makeClient({ relay_url: f.base, token: f.tokens.b });
  await a.send({ file, to: 'b', id: 'client-module' });
  const out = path.join(f.root, 'received.age'); fs.writeFileSync(out + '.part', bytes.subarray(0, 123));
  assert.equal((await b.download({ id: 'client-module', out })).bytes_verified, true);
  assert.deepEqual(fs.readFileSync(out), bytes);
  assert.equal((await b.download({ id: 'client-module', out })).bytes_verified, true);
});

test('real CLI round-trip and HTTPS enforcement', async t => {
  const f = await fixture(t); const bytes = payload('CLI fixture'); const file = path.join(f.root, 'input.age'); fs.writeFileSync(file, bytes);
  const creds = {};
  for (const id of ['a', 'b']) {
    creds[id] = path.join(f.root, `${id}.json`); fs.writeFileSync(creds[id], JSON.stringify({ relay_url: f.base, token: f.tokens[id] }), { mode: 0o600 });
  }
  assert.throws(() => readCredentials(creds.a), /https_required/);
  const run = (args, who) => exec(process.execPath, [path.join(project, 'bin/client.mjs'), ...args, '--credentials', creds[who], '--allow-local-http', 'true']);
  const sent = await run(['send', '--file', file, '--to', 'b', '--id', 'cli-roundtrip'], 'a'); assert.equal(JSON.parse(sent.stdout).status, 'ready');
  const out = path.join(f.root, 'cli-received.age');
  const got = await run(['download', '--id', 'cli-roundtrip', '--out', out], 'b'); assert.equal(JSON.parse(got.stdout).bytes_verified, true);
  assert.deepEqual(fs.readFileSync(out), bytes);
});

test('downloads resume empty partial files and preserve conflicting outputs', async t => {
  const f = await fixture(t); const bytes = payload('recover-empty-partial');
  await f.upload('empty-partial', bytes);
  const b = makeClient({ relay_url: f.base, token: f.tokens.b });
  const out = path.join(f.root, 'empty.age'); fs.writeFileSync(out + '.part', '');
  await b.download({ id: 'empty-partial', out });
  assert.deepEqual(fs.readFileSync(out), bytes);
  fs.writeFileSync(out, 'existing unrelated output');
  await assert.rejects(b.download({ id: 'empty-partial', out }), /output_already_exists/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'existing unrelated output');
  const bad = path.join(f.root, 'corrupt.age'); fs.writeFileSync(bad + '.part', Buffer.alloc(bytes.length));
  await assert.rejects(b.download({ id: 'empty-partial', out: bad }), /download_checksum_mismatch/);
  assert.equal(fs.existsSync(bad), false);
});

test('client resumes a multi-chunk upload from the confirmed server offset', async t => {
  const f = await fixture(t); const bytes = Buffer.alloc(2 * CHUNK + 1024, 0x61); AGE_MAGIC.copy(bytes);
  const file = path.join(f.root, 'large.age'); fs.writeFileSync(file, bytes);
  await f.create('multi-chunk', bytes); await f.append('multi-chunk', bytes.subarray(0, CHUNK));
  const a = makeClient({ relay_url: f.base, token: f.tokens.a }); const offsets = [];
  const result = await a.send({ file, to: 'b', id: 'multi-chunk', onProgress: p => offsets.push(p.offset) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(offsets, [CHUNK, 2 * CHUNK, bytes.length]);
  assert.deepEqual(fs.readFileSync(f.app.store.payloadPath('multi-chunk')), bytes);
});

test('tunnel override only permits loopback HTTP without embedded credentials', async t => {
  const f = await fixture(t); const file = path.join(f.root, 'credential.json');
  fs.writeFileSync(file, JSON.stringify({ relay_url: 'https://relay.example.com', token: f.tokens.a }));
  const c = readCredentials(file, false, f.base);
  assert.equal(c.relay_url, f.base); assert.equal(c.token, f.tokens.a);
  for (const url of ['http://192.0.2.1:17860', 'https://127.0.0.1', 'http://token@127.0.0.1', 'http://127.0.0.1/path']) {
    assert.throws(() => readCredentials(file, false, url), /loopback_tunnel_required/);
  }
});

test('admin CLI registers, rotates and revokes credentials without printing secrets', async t => {
  const f = await fixture(t); const data = f.app.store.root;
  const run = args => exec(process.execPath, [path.join(project, 'bin/relay.mjs'), ...args]);
  const first = path.join(f.root, 'device-first.json');
  const added = await run(['device', 'add', '--data', data, '--id', 'cli-device', '--url', 'https://relay.example.com', '--out', first]);
  const old = JSON.parse(fs.readFileSync(first));
  assert.equal(added.stdout.includes(old.token), false);
  assert.equal((await f.json(old.token, '/v1/me')).body.device_id, 'cli-device');
  await assert.rejects(run(['device', 'rotate', '--data', data, '--id', 'cli-device', '--url', 'https://relay.example.com', '--out', first]));
  assert.equal((await f.json(old.token, '/v1/me')).status, 200);
  const second = path.join(f.root, 'device-second.json');
  const rotated = await run(['device', 'rotate', '--data', data, '--id', 'cli-device', '--url', 'https://relay.example.com', '--out', second]);
  const current = JSON.parse(fs.readFileSync(second));
  assert.equal(rotated.stdout.includes(current.token), false);
  assert.equal((await f.json(old.token, '/v1/me')).status, 401);
  assert.equal((await f.json(current.token, '/v1/me')).status, 200);
  await run(['device', 'revoke', '--data', data, '--id', 'cli-device']);
  assert.equal((await f.json(current.token, '/v1/me')).status, 401);
});

test('real age archive preserves conversation and artifact files byte for byte', { skip: !process.env.AGE_BIN }, async t => {
  const f = await fixture(t);
  const age = process.env.AGE_BIN; const keygen = path.join(path.dirname(age), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen');
  const identity = path.join(f.root, 'recipient-key.txt');
  await exec(keygen, ['-o', identity]);
  const pub = (await exec(keygen, ['-y', identity])).stdout.trim();
  const bundle = path.join(f.root, 'handoff'); fs.mkdirSync(path.join(bundle, 'outputs'), { recursive: true });
  const files = {
    'HANDOFF.md': Buffer.from('任务：继续检查合成报告。\n'),
    'conversation.json': Buffer.from(JSON.stringify([{ role: 'user', content: '检查这份报告' }])),
    'outputs/报告.txt': Buffer.from('真实加密往返：会话与产出合成示例。\n'.repeat(2000)),
    'outputs/binary.bin': Buffer.from([0, 255, 128, 1, 0])
  };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(bundle, name), bytes);
  const original = path.join(f.root, 'bundle.tar.gz');
  await exec('tar', ['-czf', original, '-C', f.root, 'handoff']);
  const originalBytes = fs.readFileSync(original);
  const encrypted = path.join(f.root, 'bundle.age'); await exec(age, ['-r', pub, '-o', encrypted, original]);
  const a = makeClient({ relay_url: f.base, token: f.tokens.a }); const b = makeClient({ relay_url: f.base, token: f.tokens.b });
  const sent = await a.send({ file: encrypted, to: 'b', id: 'real-age', adapter: 'hermes.desktop', profile: 'research' });
  assert.equal(sent.adapter_id, 'hermes.desktop');
  const received = path.join(f.root, 'received.age'); await b.download({ id: 'real-age', out: received });
  const decrypted = path.join(f.root, 'decrypted.tar.gz'); await exec(age, ['-d', '-i', identity, '-o', decrypted, received]);
  assert.deepEqual(fs.readFileSync(decrypted), originalBytes);
  const restored = path.join(f.root, 'restored'); fs.mkdirSync(restored);
  await exec('tar', ['-xzf', decrypted, '-C', restored]);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(restored, 'handoff', name)), bytes);
  // The relay stores ciphertext exactly; no private key or plaintext file was uploaded.
  assert.deepEqual(fs.readFileSync(f.app.store.payloadPath('real-age')), fs.readFileSync(encrypted));
});
