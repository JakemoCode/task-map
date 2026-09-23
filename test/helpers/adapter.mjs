// Drives test/fixtures/adapter.mjs, a stand-in adapter, and watches the processes it starts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/adapter.mjs', import.meta.url));

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A fixture adapter working in `dir`, which it creates. `command` is the shell command to run it,
 * `write(data)` sets what it prints next, `warn(text)` what it prints to stderr on success, and
 * `runs()` counts how many times it has started.
 */
export function adapter(dir, data, ...flags) {
  mkdirSync(dir);
  const write = next => writeFileSync(join(dir, 'out.json'), typeof next === 'string' ? next : JSON.stringify(next));
  write(data);
  const runsFile = join(dir, 'runs');
  return {
    dir,
    write,
    warn: text => writeFileSync(join(dir, 'stderr.txt'), text),
    command: [process.execPath, FIXTURE, dir, ...flags].map(arg => JSON.stringify(String(arg))).join(' '),
    runs: () => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8').trim().split('\n').length : 0),
  };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export async function waitUntil(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await delay(25);
  }
}

/** The pids of a --hang adapter and the child it started, once both are running. */
export async function hungPids(fixture) {
  const pidFile = join(fixture.dir, 'grandchild.pid');
  await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the adapter starts its child');
  const adapterPid = Number(readFileSync(join(fixture.dir, 'runs'), 'utf8').trim().split('\n').at(-1));
  return [adapterPid, Number(readFileSync(pidFile, 'utf8'))];
}
