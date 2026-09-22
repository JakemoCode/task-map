// The page's behavior in a real headless browser. Skipped locally when Chrome is missing;
// required in CI, where a missing browser would otherwise pass as a silent skip.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { build } from '../lib/build.mjs';
import { findChrome, launchChrome } from './helpers/chrome.mjs';

const chrome = findChrome();
if (!chrome && process.env.CI) throw new Error('Chrome is required for the page tests in CI');
const skip = chrome ? false : 'Chrome is not installed';
const sample = () => JSON.parse(readFileSync(new URL('../examples/sample.json', import.meta.url), 'utf8'));

let browser;
let viewerUrl;
let scratch;
before(async () => {
  if (!chrome) return;
  scratch = mkdtempSync(join(tmpdir(), 'task-map-page-'));
  const viewer = join(scratch, 'viewer.html');
  writeFileSync(viewer, build());
  viewerUrl = pathToFileURL(viewer).href;
  browser = await launchChrome(chrome);
});
after(async () => {
  await browser?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function openViewer() {
  const page = await browser.open(viewerUrl);
  await page.waitFor(`document.querySelector('.drop') !== null`);
  return page;
}

// What a user does: drag a file onto the page.
async function drop(page, data, waitForTitle = data.title) {
  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(JSON.stringify(data))}], 'map.json', { type: 'application/json' }));
    const main = document.querySelector('main');
    for (const type of ['dragover', 'drop']) {
      main.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }
  })()`);
  await page.waitFor(`document.title === ${JSON.stringify(waitForTitle)} && document.querySelectorAll('#viewport .node').length > 0`);
}

// The zoom factor one wheel notch applies, read from the viewport transform.
async function wheelRatio(page) {
  return page.evaluate(`(() => {
    const scale = () => Number(/scale\\(([-\\d.e]+)\\)/.exec(document.getElementById('viewport').getAttribute('transform'))[1]);
    const svg = document.getElementById('map');
    const before = scale();
    svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    return scale() / before;
  })()`);
}

const count = (page, selector) => page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

// The view a user builds up: zoom, filters, focus, and an open panel.
function view(page) {
  return page.evaluate(`({
    transform: document.getElementById('viewport').getAttribute('transform'),
    chips: [...document.querySelectorAll('#chips .chip')].map(chip => chip.getAttribute('aria-pressed')),
    focus: document.getElementById('focus').value,
    panelOpen: document.getElementById('panel').classList.contains('open'),
    panelStatus: document.querySelector('#panel .pill')?.textContent ?? null,
  })`);
}

async function focusOn(page, id) {
  await page.evaluate(`(() => {
    const focus = document.getElementById('focus');
    focus.value = ${JSON.stringify(id)};
    focus.dispatchEvent(new Event('change'));
  })()`);
}

// Keyboard selection: the same path a user takes with Tab and Enter.
async function selectNode(page, id) {
  await page.evaluate(`(() => {
    const node = document.querySelector('#viewport .node[data-id=${JSON.stringify(id)}]');
    node.focus();
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await page.waitFor(`document.getElementById('panel').classList.contains('open')`);
}

// The sample without one node and everything that points at it. Only for nodes with no children.
function without(data, id) {
  data.nodes = data.nodes.filter(node => node.id !== id);
  data.edges = data.edges.filter(edge => edge.from !== id && edge.to !== id);
  for (const node of data.nodes) {
    if (node.links) node.links = node.links.filter(link => link.to !== id);
    for (const section of node.sections ?? []) if (section.refs) section.refs = section.refs.filter(ref => ref !== id);
  }
  return data;
}

test('when the selected or focused node disappears, the panel closes and focus returns to the whole map', { skip }, async () => {
  const page = await openViewer();
  await drop(page, sample());
  await focusOn(page, 'M3');
  await selectNode(page, 'T-33');

  const withoutSelected = without(sample(), 'T-33');
  withoutSelected.title = 'Lantern, T-33 gone';
  await drop(page, withoutSelected);
  assert.equal((await view(page)).panelOpen, false, 'the panel still shows a node that no longer exists');
  assert.equal((await view(page)).focus, 'M3');

  await focusOn(page, 'M5');
  const withoutFocused = without(withoutSelected, 'M5');
  withoutFocused.title = 'Lantern, M5 gone';
  await drop(page, withoutFocused);
  assert.equal((await view(page)).focus, '');
  assert.equal(await count(page, '#viewport .node[data-id="M3"]'), 1, 'the whole map is drawn again');
});

test('when a vanished focus returns to the whole map, the whole map fits on screen', { skip }, async () => {
  const page = await openViewer();
  await drop(page, sample());
  await focusOn(page, 'M7');
  const withoutFocus = without(sample(), 'M7');
  withoutFocus.title = 'Lantern, M7 gone';
  await drop(page, withoutFocus);

  const offscreen = await page.evaluate(`(() => {
    const view = document.getElementById('map').getBoundingClientRect();
    return [...document.querySelectorAll('#viewport .node')].filter(node => {
      const box = node.getBoundingClientRect();
      return box.left < view.left || box.right > view.right || box.top < view.top || box.bottom > view.bottom;
    }).map(node => node.dataset.id);
  })()`);
  assert.deepEqual(offscreen, []);
});

test('new data keeps the panel scrolled where it was and keyboard focus on the same node', { skip }, async () => {
  const page = await openViewer();
  await page.evaluate(`window.resizeTo?.(1400, 420)`);
  await drop(page, sample());
  await selectNode(page, 'M3');
  const scrolled = await page.evaluate(`(() => {
    const panel = document.getElementById('panel');
    panel.scrollTop = 120;
    return panel.scrollTop;
  })()`);
  assert.ok(scrolled > 0, 'the panel is tall enough to scroll');

  const next = sample();
  next.title = 'Lantern, refreshed';
  await drop(page, next);

  assert.equal(await page.evaluate(`document.getElementById('panel').scrollTop`), scrolled);
  assert.equal(await page.evaluate(`document.activeElement?.closest?.('.node')?.dataset.id ?? null`), 'M3');
});

test('new data keeps the zoom, filters, focus, and open panel, and shows what changed', { skip }, async () => {
  const page = await openViewer();
  await drop(page, sample());
  await wheelRatio(page);
  await page.evaluate(`document.querySelector('#chips .chip[data-status="done"]').click()`);
  await focusOn(page, 'M3');
  await selectNode(page, 'T-33');
  const before = await view(page);
  assert.equal(before.panelStatus, 'failed');

  const next = sample();
  next.title = 'Lantern, later';
  Object.assign(next.nodes.find(n => n.id === 'T-33'), { status: 'review', detail: 'PR #300' });
  await drop(page, next);

  assert.deepEqual(await view(page), { ...before, panelStatus: 'in review' });
  assert.equal(await page.evaluate(`document.querySelector('#viewport .node[data-id="T-33"]').classList.contains('s-review')`), true);
});

test('after a file with errors, dropping a valid one draws the map', { skip }, async () => {
  const page = await openViewer();
  const broken = sample();
  broken.title = 'Broken';
  broken.nodes[0].status = 'doing';
  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(JSON.stringify(broken))}], 'bad.json'));
    document.querySelector('main').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  })()`);
  await page.waitFor(`document.querySelector('.message ol') !== null`);

  await drop(page, sample());
  assert.equal(await count(page, '#viewport .node[data-id="M3"]'), 1);
});

test('dropping a second file replaces the data without duplicating the controls', { skip }, async () => {
  const page = await openViewer();
  await drop(page, sample());
  const controls = { chips: await count(page, '#chips .chip'), legend: await count(page, '#legend > span') };
  const ratio = await wheelRatio(page);

  const second = sample();
  second.title = 'Second map';
  await drop(page, second);

  assert.deepEqual({ chips: await count(page, '#chips .chip'), legend: await count(page, '#legend > span') }, controls);
  assert.equal(await count(page, '#focus option'), 1 + second.nodes.filter(n => n.kind === 'milestone' || n.kind === 'gate').length);
  assert.ok(Math.abs(await wheelRatio(page) - ratio) < 1e-9, 'one wheel notch should zoom by the same factor as before');
});

test('the drop screen says how to make a data file and how to keep it live', { skip }, async () => {
  const page = await openViewer();
  const help = await page.evaluate(`(() => {
    const drop = document.querySelector('.drop');
    const link = [...drop.querySelectorAll('a')].find(a => a.textContent === 'AGENTS.md');
    return { text: drop.textContent, href: link?.href ?? null };
  })()`);
  assert.equal(help.href, 'https://github.com/JakemoCode/task-map/blob/main/AGENTS.md');
  assert.match(help.text, /adapter/);
  assert.match(help.text, /task-map-serve --adapter "<command>"/);
});
