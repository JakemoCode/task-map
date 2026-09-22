# AGENTS.md

This repo draws a project as an interactive dependency map from one JSON file. An **adapter** reads a tracker and writes that file. The page owns everything visual: layout, filtering, the frontier view, which edges to draw. An adapter decides what each tracker object *is*, never where it goes.

Two kinds of work happen here:

- **Wiring a tracker** into the map: follow "Write an adapter".
- **Changing the page or the format**: follow "Change the format or the page".

## Write an adapter

The adapter lives wherever the user's project does, in any language, and writes one JSON file. It needs this repo only to validate and build.

`docs/data-format.md` is the contract: every field, status, edge type, and rule. `docs/tracker-recipes.md` has starting mappings for GitHub, Linear, Jira, and spreadsheets; read the section for the tracker you are wiring.

1. **Read the contract.** Read `docs/data-format.md` end to end, and your tracker's section of `docs/tracker-recipes.md`. Done when you can name which of the four kinds (milestone, gate, task, issue) each object type in the tracker becomes, or that it stays off the map.

2. **Choose the spine.** The spine is the milestones and gates: the planned structure everything else hangs off. Pick the tracker objects that play that role, and how their order is known (explicit dependencies, due dates, numbering). Ask the user when two choices are plausible; the spine is the one decision that reshapes the whole map. Done when every milestone and gate has a source object, an id rule, and an ordering rule.

3. **Fill the status worksheet.** Copy this table into your working notes and add one row per state the tracker can report, including states only reachable through a PR, a CI run, or a board column:

   | Tracker state (and where it is read from) | Status | `queued` | `detail` |
   |---|---|---|---|

   Pull every state from the tracker's own list of states, workflow, or board columns, rather than from the states that happen to be present in today's data. Done when every state the tracker can report has a row, and every row names one of the nine statuses or "left off the map".

4. **Derive the edges.** Map the tracker's dependency relation to `dep` edges, its reviews or checkpoints to `gate` edges, and fixes to `resolves` edges. Tickets attach to the spine through `parent`, never through an edge. Done when every relation type the tracker has is either mapped to an edge type, mapped to a link, or recorded in your notes as ignored.

5. **Choose `detail` and `links`.** `detail` is the one fact a reader needs to act on the status: the failing check, the PR number, what it waits on. `links` carry relations that are not structure: a strong link for a declared or cited relation, a weak link for a passing mention. Done when every status in the worksheet names its `detail` source, or none.

6. **Write the adapter and validate.** Run it, then `node bin/validate.mjs <output.json>`. Fix what it reports and rerun until it exits 0. Done when it exits 0 and every warning names a ticket you intend for the unanchored tray.

7. **Check id stability.** Run the adapter twice with no tracker changes between runs and compare the sorted node ids. Done when the two lists are identical. Stable ids are what keep a selection, a link, and a user's bookmark meaningful across refreshes.

8. **Look at it.** `node bin/build.mjs <output.json> -o map.html` and open the file. Done when every piece of work the tracker shows as active appears in the frontier view, and every milestone sits after the milestones it depends on.

Report the worksheet, the spine choice, and anything left off the map, so the user can check the judgment calls.

## Change the format or the page

- `src/validate.js` is the format's single source of truth. `schema/task-map.schema.json` and `docs/data-format.md` restate it for other languages and for readers. A format change edits all three and `test/validate.test.mjs` together; a test pins the schema's enumerated values to the validator's.
- A change that makes previously valid data invalid, or renders it differently in meaning, raises `VERSION` in `src/validate.js` and the schema's `version` const.
- The page is `src/task-map.html` plus `src/validate.js` and `vendor/dagre.min.js`, which `lib/build.mjs` inlines. The page has no build step of its own and no runtime dependencies. Library code lives in `lib/`; each file in `bin/` is a plain command line over it, installed as `task-map-build` and `task-map-validate`.
- `npm test` runs every check. `npm run build` refreshes `dist/`; the tests fail while `dist/` is stale. `test/page.test.mjs` drives the page in headless Chrome through `test/helpers/chrome.mjs`: it skips locally without Chrome and fails in CI without it. Set `CHROME_PATH` to point it at a specific browser.
- Check a visual change in a browser against `dist/sample.html`, which exercises every status, both spine kinds, queued work, links, and the tray.
