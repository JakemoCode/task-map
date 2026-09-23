// A local server for a live map: the page at /, the latest data at /data. It refreshes lazily: a
// request for /data finds the cache older than the interval, starts one refresh in the background,
// and returns the cache as it stands.
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

import { build } from './build.mjs';

const { validate } = createRequire(import.meta.url)('../src/validate.js');

const WINDOWS = process.platform === 'win32';
const STDERR_KEPT = 2048;
const STDERR_MAX = 256 * 1024;
const STDOUT_MAX = 16 * 1024 * 1024;

/**
 * Starts the server on 127.0.0.1. The data comes from `adapter`, a shell command that prints it,
 * or from `data`, a JSON file to re-read. `interval` is how old the data may get, and `poll` how
 * often the page asks for it, both in seconds.
 */
export async function startServer({ adapter, data: dataFile, interval = 60, poll = 10, port = 4173, timeout = 120 }) {
  const page = build(undefined, { live: { poll } });
  const cache = { data: null, checkedAt: null, updatedAt: null, running: false, error: null, warnings: [] };
  let lastRun = -Infinity;
  let lastFingerprint;
  let inFlight = null;

  async function refresh() {
    cache.running = true;
    try {
      const { stdout, stderr } = adapter
        ? await runAdapter(adapter, timeout, child => { inFlight = child; })
        : { stdout: await readFile(dataFile, 'utf8'), stderr: '' };
      const data = JSON.parse(stdout);
      const { errors, warnings } = validate(data);
      if (errors.length) throw new Error(errors.map(({ path, message }) => `${path} ${message}`).join('; '));
      // generatedAt changes on every run; only the rest says whether the map changed.
      const fingerprint = JSON.stringify({ ...data, generatedAt: undefined });
      const now = new Date().toISOString();
      if (fingerprint !== lastFingerprint) cache.updatedAt = now;
      lastFingerprint = fingerprint;
      cache.data = data;
      // What a successful adapter prints to stderr is its warnings. They describe this data, so a
      // later failed run leaves them in place.
      cache.warnings = [
        ...stderr.split('\n').map(line => line.trim()).filter(Boolean),
        ...warnings.map(({ path, message }) => `${path} ${message}`),
      ];
      cache.checkedAt = now;
      cache.error = null;
    } catch (error) {
      cache.error = error.message;
    } finally {
      inFlight = null;
      cache.running = false;
      lastRun = Date.now();
    }
  }

  let bound;
  const server = createServer((req, res) => {
    // A page on another site may reach 127.0.0.1 under a rebound DNS name, or by plain navigation.
    // Browsers leave port 80 out of the Host header.
    const hosts = [`127.0.0.1:${bound}`, `localhost:${bound}`, ...(bound === 80 ? ['127.0.0.1', 'localhost'] : [])];
    if (!hosts.includes(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end();
      return;
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
    if (path !== '/data') {
      res.writeHead(404).end();
      return;
    }
    if (!cache.running && Date.now() - lastRun >= interval * 1000) refresh();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(cache));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  bound = server.address().port;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    close: () => new Promise(resolve => {
      if (inFlight) killTree(inFlight);
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// Runs the command in its own process group, so everything it starts can be killed together.
function runAdapter(command, timeout, started) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !WINDOWS, windowsHide: true });
    started(child);
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let failure = null;
    const timer = setTimeout(() => {
      failure = new Error(`adapter timed out after ${timeout}s`);
      killTree(child);
    }, timeout * 1000);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= STDOUT_MAX) stdout.push(chunk);
      else if (!failure) {
        failure = new Error('adapter printed more than 16 MiB');
        killTree(child);
      }
    });
    // Drained so a chatty adapter never blocks on a full pipe. Kept whole up to a cap, since on a
    // successful run every line is a warning.
    let stderrOmitted = false;
    child.stderr.setEncoding('utf8').on('data', chunk => {
      if (stderr.length + chunk.length <= STDERR_MAX) stderr += chunk;
      else stderrOmitted = true;
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) {
        const omitted = stderrOmitted ? '\nadapter printed more than 256 KiB to stderr; the rest is not shown' : '';
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderr + omitted });
      } else {
        // The end of stderr is what explains a failure.
        const tail = stderr.trim().slice(-STDERR_KEPT);
        reject(new Error(`adapter exited with code ${code}${tail ? `: ${tail}` : ''}`));
      }
    });
  });
}

// The whole group, even after the shell itself has exited: what it started may still be running.
// Best effort: it runs from timers and exit handlers, where a throw would take the server down.
function killTree(child) {
  if (!child.pid) return;
  try {
    if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone (ESRCH), or not ours to kill.
  }
}
