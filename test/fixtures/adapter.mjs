// A stand-in adapter for the server tests: prints <dir>/out.json and appends a line to <dir>/runs
// each time it runs, so a test can count runs. When out.json starts with "FAIL:", it prints the
// rest to stderr and exits 3 instead. --hang starts a child of its own, writes that child's pid to
// <dir>/grandchild.pid, and never finishes: the case a kill has to clean up after. --bytes n prints
// n bytes of filler instead of the data.
//
//   node adapter.mjs <dir> [--sleep ms] [--hang] [--bytes n]
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...flags] = process.argv.slice(2);
const flag = name => (flags.includes(name) ? flags[flags.indexOf(name) + 1] ?? true : undefined);

appendFileSync(join(dir, 'runs'), `${process.pid}\n`);
if (flag('--hang')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'grandchild.pid'), String(child.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const sleep = Number(flag('--sleep') ?? 0);
if (sleep) await new Promise(resolve => setTimeout(resolve, sleep));
// No process.exit after a write: it would cut off output still queued for the pipe.
const out = readFileSync(join(dir, 'out.json'), 'utf8');
if (flag('--bytes')) {
  process.stdout.write('x'.repeat(Number(flag('--bytes'))));
} else if (out.startsWith('FAIL:')) {
  process.stderr.write(out.slice('FAIL:'.length));
  process.exitCode = 3;
} else {
  process.stdout.write(out);
}
