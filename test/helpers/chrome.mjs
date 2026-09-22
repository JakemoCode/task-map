// A minimal headless Chrome driver over the DevTools protocol, using Node's built-in WebSocket,
// so the page's behavior can be tested in a real browser without adding a dependency.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .map(name => spawnSync('which', [name], { encoding: 'utf8' }).stdout?.trim()),
];

/** The Chrome binary to drive, or null when none is installed. */
export function findChrome() {
  return CANDIDATES.find(path => path && existsSync(path)) ?? null;
}

export async function launchChrome(binary) {
  const profile = mkdtempSync(join(tmpdir(), 'task-map-chrome-'));
  // Ubuntu 24.04 runners restrict the user namespaces Chrome's sandbox needs.
  const sandbox = process.env.CI ? ['--no-sandbox'] : [];
  const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', ...sandbox, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });

  const endpoint = await new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${seen}`)), 15000);
    child.stderr.on('data', chunk => {
      seen += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited with ${code}:\n${seen}`)); });
  });

  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  return {
    /** Open `url` in a new tab and return helpers bound to it. */
    async open(url) {
      const { targetId } = await send('Target.createTarget', { url });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const evaluate = async expression => {
        const { result, exceptionDetails } = await send('Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      };
      const waitFor = async (expression, timeout = 5000) => {
        const deadline = Date.now() + timeout;
        for (;;) {
          if (await evaluate(expression)) return;
          if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
      return { evaluate, waitFor };
    },
    async close() {
      // Chrome keeps writing its profile until it exits; removing it earlier races those writes.
      const exited = new Promise(resolve => child.once('exit', resolve));
      await send('Browser.close').catch(() => {});
      socket.close();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
      child.kill();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
