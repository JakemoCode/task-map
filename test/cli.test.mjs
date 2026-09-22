import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = join(ROOT, 'examples/sample.json');
const bins = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).bin ?? {};
const scratch = mkdtempSync(join(tmpdir(), 'task-map-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// npm installs each "bin" entry as a symlink in node_modules/.bin; run through one the same way.
function linked(name) {
  assert.ok(bins[name], `package.json has no bin entry for ${name}`);
  const link = join(scratch, name);
  if (!existsSync(link)) symlinkSync(join(ROOT, bins[name]), link);
  return link;
}

function installed(name) {
  const link = linked(name);
  return (...args) => spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', cwd: scratch });
}

test('task-map-build, run as an installed command, writes the map', () => {
  const out = join(scratch, 'map.html');
  const run = installed('task-map-build')(SAMPLE, '-o', out);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(out), 'no output file was written');
  assert.match(readFileSync(out, 'utf8'), /"title":"Lantern task map"/);
});

test('task-map-validate, run as an installed command, reports a valid file', () => {
  const run = installed('task-map-validate')(SAMPLE);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /valid, 28 nodes, 22 edges/);
});

test('task-map-serve without exactly one of --adapter and --data prints usage and exits 2', () => {
  const serve = installed('task-map-serve');
  for (const args of [[], ['--adapter', 'true', '--data', SAMPLE], ['--data']]) {
    const run = serve(...args);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, /usage: task-map-serve/);
  }
});

test('task-map-serve on a port already in use says to pick another with --port', async () => {
  const taken = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => taken.once('listening', resolve));
  try {
    const run = installed('task-map-serve')('--data', SAMPLE, '--port', String(taken.address().port));
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, new RegExp(`port ${taken.address().port} is in use.*--port`));
  } finally {
    taken.close();
  }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await delay(25);
  }
}

test('Ctrl-C on task-map-serve leaves no adapter process behind', async t => {
  const dir = join(scratch, 'hung-adapter');
  mkdirSync(dir);
  writeFileSync(join(dir, 'out.json'), '{}');
  const fixture = fileURLToPath(new URL('fixtures/adapter.mjs', import.meta.url));
  const command = [process.execPath, fixture, dir, '--hang'].map(arg => JSON.stringify(arg)).join(' ');
  const serve = spawn(process.execPath, [linked('task-map-serve'), '--adapter', command, '--port', '0'],
    { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => serve.once('exit', (code, signal) => resolve({ code, signal })));
  let stdout = '';
  serve.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  const pidFile = join(dir, 'grandchild.pid');
  const pids = () => [
    Number(readFileSync(join(dir, 'runs'), 'utf8').trim()),
    Number(readFileSync(pidFile, 'utf8')),
  ];
  t.after(() => {
    serve.kill('SIGKILL');
    if (existsSync(pidFile)) for (const pid of pids()) try { process.kill(pid, 'SIGKILL'); } catch {}
  });

  await waitUntil(() => /http:\/\/\S+/.test(stdout), 'the server prints its address');
  await fetch(`${/http:\/\/\S+/.exec(stdout)[0]}/data`);
  await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the adapter starts its child');
  assert.ok(pids().every(alive), 'the adapter and its child are running');

  serve.kill('SIGINT');
  const { code, signal } = await exited;
  assert.ok(code === 130 || signal === 'SIGINT', `exited with ${code ?? signal}`);
  await waitUntil(() => !pids().some(alive), `no process of ${pids()} is left`);
});
