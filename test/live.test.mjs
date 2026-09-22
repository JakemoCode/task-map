// The page in live mode, in headless Chrome, served by a real task-map-serve server. Skipped
// locally when Chrome is missing; required in CI, like the other page tests.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { startServer } from '../lib/serve.mjs';
import { adapter as fixtureAdapter, delay } from './helpers/adapter.mjs';
import { findChrome, launchChrome } from './helpers/chrome.mjs';

const chrome = findChrome();
if (!chrome && process.env.CI) throw new Error('Chrome is required for the page tests in CI');
const skip = chrome ? false : 'Chrome is not installed';
const sample = () => JSON.parse(readFileSync(new URL('../examples/sample.json', import.meta.url), 'utf8'));

let browser;
let scratch;
let files = 0;
before(async () => {
  if (!chrome) return;
  scratch = mkdtempSync(join(tmpdir(), 'task-map-live-'));
  browser = await launchChrome(chrome);
});
after(async () => {
  await browser?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function dataFile(data) {
  const path = join(scratch, `data-${files++}.json`);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

const adapter = (data, ...flags) => fixtureAdapter(join(scratch, `adapter-${files++}`), data, ...flags);
const statusText = page => page.evaluate(`document.getElementById('live').textContent`);
const nodesDrawn = page => page.evaluate(`document.querySelectorAll('#viewport .node').length`);

async function serve(t, options) {
  const server = await startServer({ port: 0, interval: 0, poll: 0.2, ...options });
  t.after(() => server.close());
  return server;
}

async function openLive(server) {
  const page = await browser.open(server.url);
  await page.waitFor(`document.querySelectorAll('#viewport .node').length > 0`);
  return page;
}

async function selectNode(page, id) {
  await page.evaluate(`(() => {
    const node = document.querySelector('#viewport .node[data-id=${JSON.stringify(id)}]');
    node.focus();
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await page.waitFor(`document.getElementById('panel').classList.contains('open')`);
}

test('a live page draws the served data, then changes a node in place when the data changes', { skip }, async t => {
  const file = dataFile(sample());
  const server = await serve(t, { data: file });
  const page = await openLive(server);
  assert.equal(await page.evaluate('document.title'), 'Lantern task map');
  await selectNode(page, 'T-33');

  const next = sample();
  next.nodes.find(node => node.id === 'T-33').status = 'review';
  writeFileSync(file, JSON.stringify(next));
  await page.waitFor(`document.querySelector('#viewport .node[data-id="T-33"]').classList.contains('s-review')`);
  assert.equal(await page.evaluate(`document.getElementById('panel').classList.contains('open')`), true);
  assert.equal(await page.evaluate(`document.querySelector('#panel .pill').textContent`), 'in review');
});

test('the header says whether the data is live, why a refresh failed, and when the server is gone', { skip }, async t => {
  const fixture = adapter(sample());
  const server = await serve(t, { adapter: fixture.command });
  const page = await openLive(server);
  await page.waitFor(`/^live · checked \\d+s ago$/.test(document.getElementById('live').textContent)`);
  const drawn = await nodesDrawn(page);

  fixture.write('FAIL:the tracker is down');
  await page.waitFor(`document.getElementById('live').textContent.includes('the tracker is down')`);
  assert.match(await statusText(page), /^refresh failed: adapter exited with code 3: the tracker is down · data from \d+s ago$/);
  assert.equal(await nodesDrawn(page), drawn, 'the last good map stays on screen');

  await server.close();
  await page.waitFor(`document.getElementById('live').textContent === 'server unreachable'`);
  assert.equal(await nodesDrawn(page), drawn);
  assert.equal(await page.evaluate(`document.querySelector('main .message')`), null, 'status text never replaces the map');
});

// Headless Chrome keeps every tab visible, so the test sets what the page reads and fires its event.
function setVisibility(page, state) {
  return page.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => ${JSON.stringify(state)} });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
}

// "checked Ns ago" is rewritten on every answer from the server, so while the text holds still, the
// page is not asking.
test('a hidden tab stops asking for data', { skip }, async t => {
  const server = await serve(t, { data: dataFile(sample()), interval: 3600, poll: 0.2 });
  const page = await openLive(server);
  await page.waitFor(`/^live · checked \\d+s ago$/.test(document.getElementById('live').textContent)`);
  await setVisibility(page, 'hidden');
  await delay(300);
  const hidden = await statusText(page);
  await delay(2500);
  assert.equal(await statusText(page), hidden);
});

test('a tab shown again asks for data at once, without waiting out the poll', { skip }, async t => {
  const server = await serve(t, { data: dataFile(sample()), interval: 3600, poll: 60 });
  const page = await openLive(server);
  await page.waitFor(`/^live · checked \\d+s ago$/.test(document.getElementById('live').textContent)`);
  const before = await statusText(page);
  await delay(2500);
  assert.equal(await statusText(page), before, 'no request before the 60s poll');
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.waitFor(`document.getElementById('live').textContent !== ${JSON.stringify(before)}`, 1000);
});
