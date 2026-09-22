#!/usr/bin/env node
// Checks a task-map data file against format version 1 and prints every problem with its path.
//
//   node bin/validate.mjs data.json
//
// Exit 0: valid (warnings may still print). Exit 1: invalid. Exit 2: unreadable input.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { validate } = createRequire(import.meta.url)('../src/validate.js');

const file = process.argv[2];
if (!file) {
  console.error('usage: node bin/validate.mjs <data.json>');
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const { errors, warnings } = validate(data);
for (const { path, message } of warnings) console.log(`warning  ${path} ${message}`);
for (const { path, message } of errors) console.log(`error    ${path} ${message}`);
const nodes = Array.isArray(data?.nodes) ? data.nodes.length : 0;
const edges = Array.isArray(data?.edges) ? data.edges.length : 0;
if (errors.length) {
  console.log(`${file}: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`${file}: valid, ${nodes} nodes, ${edges} edges, ${warnings.length} warning(s)`);
