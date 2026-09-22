#!/usr/bin/env node
// Builds one self-contained HTML file: the page with dagre and the validator inlined, and
// optionally a data file baked in. Without data, the result is a viewer that takes a dropped file.
//
//   node bin/build.mjs data.json -o map.html     # a map to share or open offline
//   node bin/build.mjs -o viewer.html            # the drop-a-file viewer (dist/task-map.html)
//
// Refuses invalid data, so a built map always renders.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_SLOT = '/*__TASK_MAP_DATA__*/null';
const { validate } = createRequire(import.meta.url)('../src/validate.js');

/** Inline `<script src>` tags and fill the data slot. Pure, so the tests can call it. */
export function build(data) {
  let page = readFileSync(join(ROOT, 'src/task-map.html'), 'utf8');
  for (const [tag, file] of [
    ['<script src="../vendor/dagre.min.js"></script>', 'vendor/dagre.min.js'],
    ['<script src="validate.js"></script>', 'src/validate.js'],
  ]) {
    if (!page.includes(tag)) throw new Error(`src/task-map.html no longer contains ${tag}`);
    page = page.replace(tag, () => `<script>\n${inlineSafe(readFileSync(join(ROOT, file), 'utf8'))}\n</script>`);
  }
  if (!page.includes(DATA_SLOT)) throw new Error('src/task-map.html has no data slot');
  if (data === undefined) return page;
  const { errors } = validate(data);
  if (errors.length) {
    const lines = errors.map(({ path, message }) => `  ${path} ${message}`).join('\n');
    throw new Error(`refusing to build invalid data:\n${lines}`);
  }
  // Every "<" as <: no "</script" or "<!--" in the data can reach the HTML parser.
  return page.replace(DATA_SLOT, () => JSON.stringify(data).replace(/</g, '\\u003c'));
}

// Library code: script text ends at the first "</script", whatever string it sits in.
function inlineSafe(text) {
  return text.replace(/<\/(script)/gi, '<\\/$1');
}

function main(argv) {
  const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null;
  const input = argv.find((arg, i) => !arg.startsWith('-') && argv[i - 1] !== '-o');
  if (!out) {
    console.error('usage: node bin/build.mjs [data.json] -o <out.html>');
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
