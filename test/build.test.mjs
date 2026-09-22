import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { build } from '../lib/build.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sample = () => JSON.parse(read('examples/sample.json'));

test('a build inlines the layout library, the validator, and the data', () => {
  const page = build(sample());
  assert.doesNotMatch(page, /<script src=/);
  assert.match(page, /taskMapValidate/);
  assert.match(page, /dagre/);
  assert.match(page, /"title":"Lantern task map"/);
  assert.doesNotMatch(page, /__TASK_MAP_DATA__/);
});

test('text in the data cannot end the script or open an HTML comment', () => {
  const data = sample();
  data.title = 'x </script><script>alert(1)</script> <!-- y';
  const page = build(data);
  const script = page.slice(page.indexOf('const BAKED'));
  assert.doesNotMatch(script.slice(0, script.indexOf('\n')), /<\/script|<!--/);
  assert.match(page, /x \\u003c\/script>/);
});

test('invalid data is refused, naming the problem', () => {
  const data = sample();
  data.nodes[0].status = 'doing';
  assert.throws(() => build(data), /refusing to build invalid data:[\s\S]*\(M0\)\.status must be one of/);
});

test('a build without data is the drop-a-file viewer', () => {
  const page = build();
  assert.match(page, /const BAKED = \/\*__TASK_MAP_DATA__\*\/null;/);
  assert.match(page, /Drop a task-map JSON file here/);
});

test('the committed builds in dist/ are current', () => {
  assert.equal(read('dist/task-map.html'), build(), 'run npm run build');
  assert.equal(read('dist/sample.html'), build(sample()), 'run npm run build');
});

test('the committed builds keep live mode off, so the demo pages never poll', () => {
  for (const file of ['dist/task-map.html', 'dist/sample.html']) {
    assert.match(read(file), /const LIVE = \/\*__TASK_MAP_LIVE__\*\/null;/, file);
  }
});
