// Builds one self-contained HTML page: dagre and the validator inlined, and optionally a data
// file baked in. Without data, the result is a viewer that takes a dropped file.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_SLOT = '/*__TASK_MAP_DATA__*/null';
const LIVE_SLOT = '/*__TASK_MAP_LIVE__*/null';
const { validate } = createRequire(import.meta.url)('../src/validate.js');

/**
 * The page as one string, with `data` baked in when given. Refuses invalid data. `live` turns on
 * live mode, where the page polls the server that serves it; only task-map-serve sets it.
 */
export function build(data, { live } = {}) {
  let page = readFileSync(`${ROOT}src/task-map.html`, 'utf8');
  for (const [tag, file] of [
    ['<script src="../vendor/dagre.min.js"></script>', 'vendor/dagre.min.js'],
    ['<script src="validate.js"></script>', 'src/validate.js'],
  ]) {
    if (!page.includes(tag)) throw new Error(`src/task-map.html no longer contains ${tag}`);
    page = page.replace(tag, () => `<script>\n${inlineSafe(readFileSync(`${ROOT}${file}`, 'utf8'))}\n</script>`);
  }
  if (!page.includes(DATA_SLOT)) throw new Error('src/task-map.html has no data slot');
  if (!page.includes(LIVE_SLOT)) throw new Error('src/task-map.html has no live slot');
  if (live) page = page.replace(LIVE_SLOT, () => JSON.stringify(live));
  if (data === undefined) return page;
  const { errors } = validate(data);
  if (errors.length) {
    const lines = errors.map(({ path, message }) => `  ${path} ${message}`).join('\n');
    throw new Error(`refusing to build invalid data:\n${lines}`);
  }
  // Every "<" escaped as <, so no "</script" or "<!--" in the data reaches the HTML parser.
  return page.replace(DATA_SLOT, () => JSON.stringify(data).replace(/</g, '\\u003c'));
}

// Library code: script text ends at the first "</script", whatever string it sits in.
function inlineSafe(text) {
  return text.replace(/<\/(script)/gi, '<\\/$1');
}
