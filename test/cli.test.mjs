import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = join(ROOT, 'examples/sample.json');
const bins = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).bin ?? {};
const scratch = mkdtempSync(join(tmpdir(), 'task-map-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// npm installs each "bin" entry as a symlink in node_modules/.bin; run through one the same way.
function installed(name) {
  assert.ok(bins[name], `package.json has no bin entry for ${name}`);
  const link = join(scratch, name);
  if (!existsSync(link)) symlinkSync(join(ROOT, bins[name]), link);
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
