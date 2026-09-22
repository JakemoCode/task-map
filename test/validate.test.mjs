import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { validate, KINDS, STATUSES, EDGE_TYPES } = require('../src/validate.js');
const sample = () => JSON.parse(readFileSync(new URL('../examples/sample.json', import.meta.url), 'utf8'));

function minimal() {
  return {
    version: 1,
    title: 'Test map',
    nodes: [
      { id: 'M1', kind: 'milestone', label: 'M1', title: 'First', status: 'done' },
      { id: 'M2', kind: 'milestone', label: 'M2', title: 'Second', status: 'next' },
      { id: 'G1', kind: 'gate', label: 'G1', title: 'Review', status: 'todo' },
      { id: 'T1', kind: 'task', label: 'T1', title: 'Task', status: 'todo', parent: 'M2' },
      { id: 'I1', kind: 'issue', label: '#1', title: 'Bug', status: 'open', parent: 'M2' },
    ],
    edges: [{ from: 'M1', to: 'M2', type: 'dep' }],
  };
}

function messages(data) {
  return validate(data).errors.map(({ path, message }) => `${path} ${message}`);
}

function expectError(mutate, fragment) {
  const data = minimal();
  mutate(data);
  const found = messages(data);
  assert.ok(found.some(line => line.includes(fragment)), `expected an error containing ${JSON.stringify(fragment)}, got:\n${found.join('\n')}`);
}

test('the sample and a minimal map are valid', () => {
  assert.deepEqual(validate(minimal()).errors, []);
  const result = validate(sample());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => w.path), ['$.nodes (I-92)', '$.nodes (I-93)']);
});

test('top-level shape', () => {
  assert.equal(validate(null).errors.length, 1);
  expectError(d => { d.version = 2; }, '$.version must be 1');
  expectError(d => { d.title = ''; }, '$.title must be a non-empty string');
  expectError(d => { d.nodes = {}; }, '$.nodes must be an array');
  expectError(d => { delete d.edges; }, '$.edges must be an array');
  expectError(d => { d.kindNames = { phase: 'P' }; }, '$.kindNames.phase is not a kind');
  expectError(d => { d.extra = true; }, '$.extra is not a field');
});

test('node fields', () => {
  expectError(d => { d.nodes[1].id = 'M1'; }, 'duplicates another node');
  expectError(d => { d.nodes[0].kind = 'epic'; }, '.kind must be one of');
  expectError(d => { d.nodes[0].status = 'doing'; }, '.status must be one of');
  expectError(d => { d.nodes[0].label = ''; }, '.label must be a non-empty string');
  expectError(d => { d.nodes[3].labels = ['bug']; }, 'did you mean tags?');
  expectError(d => { d.nodes[3].queued = true; }, 'only applies to status next');
  expectError(d => { d.nodes[0].progress = { done: 3, total: 2 }; }, 'exceeds total');
  expectError(d => { d.nodes[0].progress = { done: -1, total: 2 }; }, 'whole numbers');
  expectError(d => { d.nodes[3].tags = ['']; }, '.tags must be an array of non-empty strings');
});

test('parent must name a spine node, and only tickets have one', () => {
  expectError(d => { d.nodes[3].parent = 'M9'; }, 'which is not a node id');
  expectError(d => { d.nodes[4].parent = 'T1'; }, 'must name a milestone or gate');
  expectError(d => { d.nodes[1].parent = 'M1'; }, 'part of the spine and has no parent');
});

test('links and sections', () => {
  expectError(d => { d.nodes[4].links = [{ to: 'M9', why: 'x', strong: true }]; }, 'which is not a node id');
  expectError(d => { d.nodes[4].links = [{ to: 'M1', why: 'x' }]; }, '.strong must be true');
  expectError(d => { d.nodes[4].links = [{ to: 'M1', why: '', strong: true }]; }, 'must say why');
  expectError(d => { d.nodes[1].sections = [{ heading: 'Empty' }]; }, 'needs at least one of');
  expectError(d => { d.nodes[1].sections = [{ heading: 'Refs', refs: ['nope'] }]; }, 'which is not a node id');
  expectError(d => { d.nodes[1].sections = [{ heading: 'Bar', progress: { done: 2, total: 1 } }]; }, '0 <= done <= total');
});

test('edges', () => {
  expectError(d => { d.edges.push({ from: 'M2', to: 'T1', type: 'child' }); }, 'set parent on the ticket instead');
  expectError(d => { d.edges.push({ from: 'M1', to: 'M9', type: 'dep' }); }, 'which is not a node id');
  expectError(d => { d.edges.push({ from: 'M1', to: 'M2', type: 'blocks' }); }, '.type must be one of');
  expectError(d => { d.edges.push({ from: 'M1', to: 'M1', type: 'dep' }); }, 'cannot connect a node to itself');
  expectError(d => { d.edges.push({ from: 'M1', to: 'M2', type: 'gate' }); }, 'must end at a gate');
  expectError(d => { d.edges.push({ from: 'M1', to: 'M2', type: 'advisory' }); }, 'must start at a gate');
  expectError(d => { d.edges.push({ from: 'T1', to: 'I1', type: 'resolves' }); }, 'must start at an issue');
  expectError(d => { d.edges.push({ from: 'M1', to: 'M2', type: 'dep', label: 'x' }); }, '.label is not a field');
});

test('a dependency cycle is reported with its path', () => {
  expectError(d => { d.edges.push({ from: 'M2', to: 'M1', type: 'dep' }); }, 'cycle: M1 -> M2 -> M1');
});

test('a ticket with no parent and no edges is a warning, not an error', () => {
  const data = minimal();
  delete data.nodes[3].parent;
  const { errors, warnings } = validate(data);
  assert.deepEqual(errors, []);
  assert.match(warnings[0].message, /unanchored tray/);
});

test('the JSON Schema and the validator agree on every enumerated value', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/task-map.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.$defs.node.properties.kind.enum, KINDS);
  assert.deepEqual(schema.$defs.status.enum, STATUSES);
  assert.deepEqual(schema.$defs.edge.properties.type.enum, EDGE_TYPES);
});
