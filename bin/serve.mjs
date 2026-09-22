#!/usr/bin/env node
// Serves a map that keeps itself current, on this machine only.
//
//   task-map-serve --adapter "python3 adapter.py" --open   # runs the adapter when the data goes stale
//   task-map-serve --data map.json --interval 5            # re-reads a file something else writes
//
// The page polls while it is visible; the adapter runs at most once per --interval seconds.
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { startServer } from '../lib/serve.mjs';

const USAGE = 'usage: task-map-serve (--adapter "<command>" | --data <file.json>) [--interval 60] [--port 4173] [--open]';

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      adapter: { type: 'string' },
      data: { type: 'string' },
      interval: { type: 'string', default: '60' },
      port: { type: 'string', default: '4173' },
      open: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  usage(error.message);
}
if (!options.adapter === !options.data) usage('give exactly one of --adapter and --data');
const interval = Number(options.interval);
const port = Number(options.port);
if (!(interval >= 0)) usage('--interval must be a number of seconds');
if (!Number.isInteger(port) || port < 0 || port > 65535) usage('--port must be a port number');

let server;
try {
  server = await startServer({ adapter: options.adapter, data: options.data, interval, port });
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `port ${port} is in use; pick another with --port` : error.message);
  process.exit(1);
}
console.log(server.url);
if (options.open) openBrowser(server.url);

// The adapter runs in its own process group, out of reach of the terminal's Ctrl-C, so stopping
// this process has to kill it. close() kills synchronously, so it also works from the exit event.
process.on('exit', () => server.close());
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, () => process.exit(code));

function usage(problem) {
  console.error(`${problem}\n${USAGE}`);
  process.exit(2);
}

function openBrowser(url) {
  const [command, ...args] = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url]
      : ['xdg-open', url];
  spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    .on('error', () => console.error(`could not open a browser; visit ${url}`))
    .unref();
}
