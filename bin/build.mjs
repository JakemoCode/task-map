#!/usr/bin/env node
// Builds one self-contained HTML file from a data file, or the empty drop-a-file viewer.
//
//   task-map-build data.json -o map.html     # a map to share or open offline
//   task-map-build -o viewer.html            # the drop-a-file viewer (dist/task-map.html)
//
// Refuses invalid data, so a built map always renders.
import { readFileSync, writeFileSync } from 'node:fs';

import { build } from '../lib/build.mjs';

const argv = process.argv.slice(2);
const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null;
const input = argv.find((arg, i) => !arg.startsWith('-') && argv[i - 1] !== '-o');
if (!out) {
  console.error('usage: task-map-build [data.json] -o <out.html>');
  process.exit(2);
}
try {
  const data = input === undefined ? undefined : JSON.parse(readFileSync(input, 'utf8'));
  writeFileSync(out, build(data));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(out);
