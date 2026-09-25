// The live server, driven over real HTTP on a free port. Requests go through node:http because
// fetch will not let a caller set the Host header, which the server checks.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { startServer } from '../lib/serve.mjs';
import { adapter as fixtureAdapter, alive, delay, hungPids, waitUntil } from './helpers/adapter.mjs';

const sample = () => JSON.parse(readFileSync(new URL('../examples/sample.json', import.meta.url), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'task-map-serve-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let files = 0;
function dataFile(data) {
  const path = join(scratch, `data-${files++}.json`);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

const adapter = (data, ...flags) => fixtureAdapter(join(scratch, `adapter-${files++}`), data, ...flags);

async function serve(t, options) {
  const server = await startServer({ port: 0, ...options });
  t.after(() => server.close());
  return server;
}

const get = (server, path, headers = {}, host = '127.0.0.1') => send(server, 'GET', path, headers, host);
const post = (server, path, headers = {}) => send(server, 'POST', path, headers);

function send(server, method, path, headers = {}, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = request({ method, host, port: server.port, path, headers, timeout: 5000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function state(server) {
  const res = await get(server, '/data');
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

// Polls /data until `ready` holds, since a request returns the cache at once and runs in the background.
async function until(server, ready, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await state(server);
    if (ready(current)) return current;
    if (Date.now() > deadline) throw new Error(`timed out; last /data: ${JSON.stringify({ ...current, data: Boolean(current.data) })}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('a data file is served at /data, on the loopback address only', async t => {
  const server = await serve(t, { data: dataFile(sample()), interval: 60 });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const { data, error } = await until(server, current => current.data);
  assert.equal(data.title, 'Lantern task map');
  assert.equal(error, null);

  const outside = Object.values(networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal);
  if (!outside) return t.diagnostic('no non-loopback address to try');
  await assert.rejects(get(server, '/data', {}, outside.address), /ECONNREFUSED/);
});

test('a request from another site or under another host name is refused', async t => {
  const server = await serve(t, { data: dataFile(sample()), interval: 60 });
  // DNS rebinding: a hostile name resolving to 127.0.0.1 arrives with its own Host header.
  assert.equal((await get(server, '/data', { Host: `evil.example:${server.port}` })).status, 403);
  assert.equal((await get(server, '/data', { Host: '127.0.0.1:1' })).status, 403);
  assert.equal((await get(server, '/', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await get(server, '/data', { Host: `localhost:${server.port}` })).status, 200);
  assert.equal((await get(server, '/data', { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await get(server, '/data')).headers['access-control-allow-origin'], undefined);
});

test('the page at / is the viewer in live mode, polling at the given rate', async t => {
  const server = await serve(t, { data: dataFile(sample()), interval: 60, poll: 2 });
  const res = await get(server, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /const LIVE = \{"poll":2\};/);
  assert.match(res.body, /const BAKED = \/\*__TASK_MAP_DATA__\*\/null;/);
});

test('stale data starts one adapter run however many requests arrive; fresh data starts none', async t => {
  const fresh = adapter(sample());
  const freshServer = await serve(t, { adapter: fresh.command, interval: 3600 });
  await until(freshServer, current => current.data);
  await Promise.all([1, 2, 3, 4, 5].map(() => state(freshServer)));
  await delay(200);
  assert.equal(fresh.runs(), 1);

  const slow = adapter(sample(), '--sleep', 300);
  const server = await serve(t, { adapter: slow.command, interval: 0 });
  // The request that first sees data finds it stale, so it has already started the second run.
  const seen = await until(server, current => current.data);
  assert.equal(seen.running, true);
  await Promise.all([1, 2, 3, 4, 5].map(() => state(server)));
  await delay(600);
  assert.equal(slow.runs(), 2, 'requests during a run must not start another');
});

test('a POST to /refresh runs the adapter at once, however fresh the data', async t => {
  const fixture = adapter(sample());
  const server = await serve(t, { adapter: fixture.command, interval: 3600 });
  const first = await until(server, current => current.checkedAt);
  const next = sample();
  next.title = 'Lantern, edited';
  fixture.write(next);

  assert.equal((await get(server, '/refresh')).status, 405);
  assert.equal((await get(server, '/refresh')).headers.allow, 'POST');
  assert.equal((await post(server, '/refresh', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  await delay(200);
  assert.equal(fixture.runs(), 1, 'a GET or a cross-site POST starts no run');

  const res = await post(server, '/refresh');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).running, true, 'the answer says the run has started');
  const refreshed = await until(server, current => current.checkedAt !== first.checkedAt);
  assert.equal(refreshed.data.title, 'Lantern, edited');
  assert.equal(fixture.runs(), 2);
});

test('refreshes asked for during a run start one more run after it', async t => {
  const fixture = adapter(sample(), '--sleep', 300);
  const server = await serve(t, { adapter: fixture.command, interval: 3600 });
  assert.equal((await state(server)).running, true);
  await Promise.all([1, 2, 3].map(() => post(server, '/refresh')));
  // The second run starts as the first ends, so running stays true until both are done.
  await until(server, current => !current.running);
  await delay(600);
  assert.equal(fixture.runs(), 2);
});

test('closing the server drops a refresh asked for during the run it kills', async t => {
  const fixture = adapter(sample(), '--hang');
  const server = await serve(t, { adapter: fixture.command, interval: 60 });
  await state(server);
  const pids = await hungPids(fixture);
  await post(server, '/refresh');
  await server.close();
  await waitUntil(() => !pids.some(alive), `no process of ${pids} is left`);
  await delay(300);
  assert.equal(fixture.runs(), 1);
});

test('a run that finds the same data moves checkedAt but not updatedAt', async t => {
  const fixture = adapter(sample());
  const server = await serve(t, { adapter: fixture.command, interval: 0 });
  const first = await until(server, current => current.checkedAt);

  fixture.write({ ...sample(), generatedAt: '2026-09-23 08:00 UTC' });
  const same = await until(server, current => current.checkedAt !== first.checkedAt);
  assert.equal(same.updatedAt, first.updatedAt, 'only generatedAt changed, which is not a change to the map');

  const next = sample();
  next.nodes.find(node => node.id === 'T-33').status = 'review';
  fixture.write(next);
  const changed = await until(server, current => current.updatedAt !== first.updatedAt);
  assert.equal(changed.data.nodes.find(node => node.id === 'T-33').status, 'review');
});

test('a data file is read again once the data is older than the interval', async t => {
  const file = dataFile(sample());
  const server = await serve(t, { data: file, interval: 0 });
  await until(server, current => current.data);
  const next = sample();
  next.title = 'Lantern, edited';
  writeFileSync(file, JSON.stringify(next));
  await until(server, current => current.data.title === 'Lantern, edited');
});

test('a failed run keeps the last good data and says why it failed', async t => {
  const fixture = adapter(sample());
  const server = await serve(t, { adapter: fixture.command, interval: 0 });
  const good = await until(server, current => current.data);
  const kept = current => {
    assert.deepEqual(current.data, good.data);
    assert.equal(current.updatedAt, good.updatedAt);
  };

  fixture.write('{ not json');
  kept(await until(server, current => /JSON/.test(current.error ?? '')));

  const invalid = sample();
  invalid.nodes[0].status = 'doing';
  fixture.write(invalid);
  kept(await until(server, current => /\(M0\)\.status must be one of/.test(current.error ?? '')));

  fixture.write('FAIL:the tracker said no');
  const failed = await until(server, current => /the tracker said no/.test(current.error ?? ''));
  assert.match(failed.error, /exited with code 3/);
  kept(failed);

  fixture.write(sample());
  await until(server, current => current.error === null);
});

test('an adapter that runs past the timeout is killed with everything it started', async t => {
  const fixture = adapter(sample(), '--hang');
  const server = await serve(t, { adapter: fixture.command, interval: 60, timeout: 0.5 });
  await state(server);
  const pids = await hungPids(fixture);
  assert.ok(pids.every(alive), 'the adapter and its child are running');
  await until(server, current => /timed out after 0\.5s/.test(current.error ?? ''));
  await waitUntil(() => !pids.some(alive), `no process of ${pids} is left`);
});

test('closing the server kills an adapter still running', async t => {
  const fixture = adapter(sample(), '--hang');
  const server = await serve(t, { adapter: fixture.command, interval: 60 });
  await state(server);
  const pids = await hungPids(fixture);
  await server.close();
  await waitUntil(() => !pids.some(alive), `no process of ${pids} is left`);
});

test('an adapter that prints more than 16 MiB fails instead of filling memory', async t => {
  const fixture = adapter(sample(), '--bytes', 16 * 1024 * 1024 + 1);
  const server = await serve(t, { adapter: fixture.command, interval: 60 });
  const current = await until(server, now => now.error);
  assert.match(current.error, /more than 16 MiB/);
  assert.equal(current.data, null);
});

test('a successful run reports the adapter\'s stderr and the validator\'s warnings as warnings', async t => {
  const fixture = adapter(sample());
  fixture.warn('task-map: dropped dep WP-12.7 -> WP-12.1\n\nsecond line\n');
  const server = await serve(t, { adapter: fixture.command, interval: 0 });
  const warned = await until(server, current => current.warnings?.length);
  assert.deepEqual(warned.warnings, [
    'task-map: dropped dep WP-12.7 -> WP-12.1',
    'second line',
    '$.nodes (I-92) has no parent and no edges, so it is drawn in the unanchored tray',
    '$.nodes (I-93) has no parent and no edges, so it is drawn in the unanchored tray',
  ]);

  fixture.warn('');
  const clean = await until(server, current => current.warnings.length === 2);
  assert.match(clean.warnings[0], /\(I-92\)/);
});

test('a data file reports the validator\'s warnings too', async t => {
  const server = await serve(t, { data: dataFile(sample()), interval: 60 });
  const { warnings } = await until(server, current => current.data);
  assert.equal(warnings.length, 2);
});

test('a failed run keeps the warnings of the data still on screen', async t => {
  const fixture = adapter(sample());
  fixture.warn('stale ticket skipped\n');
  const server = await serve(t, { adapter: fixture.command, interval: 0 });
  await until(server, current => current.warnings?.includes('stale ticket skipped'));
  fixture.write('FAIL:the tracker is down');
  const failed = await until(server, current => /tracker is down/.test(current.error ?? ''));
  assert.ok(failed.warnings.includes('stale ticket skipped'));
});

test('every warning line survives, however many the adapter prints', async t => {
  const fixture = adapter(sample());
  const lines = Array.from({ length: 60 }, (_, i) => `task-map: dropped dep WP-12.${i} -> WP-12.${i + 100}: it names a missing node`);
  fixture.warn(`${lines.join('\n')}\n`);
  const server = await serve(t, { adapter: fixture.command, interval: 60 });
  const { warnings } = await until(server, current => current.data);
  assert.deepEqual(warnings.slice(0, 60), lines);
});
