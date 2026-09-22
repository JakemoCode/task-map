// The live server, driven over real HTTP on a free port. Requests go through node:http because
// fetch will not let a caller set the Host header, which the server checks.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { startServer } from '../lib/serve.mjs';

const sample = () => JSON.parse(readFileSync(new URL('../examples/sample.json', import.meta.url), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'task-map-serve-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let files = 0;
function dataFile(data) {
  const path = join(scratch, `data-${files++}.json`);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

const FIXTURE = new URL('fixtures/adapter.mjs', import.meta.url).pathname;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A fixture adapter in its own directory: `write(data)` sets what it prints next, `runs()` counts runs.
function adapter(data, ...flags) {
  const dir = join(scratch, `adapter-${files++}`);
  mkdirSync(dir);
  const write = next => writeFileSync(join(dir, 'out.json'), typeof next === 'string' ? next : JSON.stringify(next));
  write(data);
  const runsFile = join(dir, 'runs');
  return {
    dir,
    write,
    command: [process.execPath, FIXTURE, dir, ...flags].map(arg => JSON.stringify(String(arg))).join(' '),
    runs: () => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8').trim().split('\n').length : 0),
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitUntil(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await delay(25);
  }
}

// The pids of a --hang adapter and the child it started, once both are running.
async function hungPids(fixture) {
  const pidFile = join(fixture.dir, 'grandchild.pid');
  await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the adapter starts its child');
  const adapterPid = Number(readFileSync(join(fixture.dir, 'runs'), 'utf8').trim().split('\n').at(-1));
  return [adapterPid, Number(readFileSync(pidFile, 'utf8'))];
}

async function serve(t, options) {
  const server = await startServer({ port: 0, ...options });
  t.after(() => server.close());
  return server;
}

function get(server, path, headers = {}, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = request({ host, port: server.port, path, headers, timeout: 5000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${path} timed out`)));
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
