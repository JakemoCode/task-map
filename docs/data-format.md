# Data format, version 1

One JSON object describes the whole map. `src/validate.js` enforces every rule below; `schema/task-map.schema.json` expresses the structural half for tools in other languages. When this page and the validator disagree, the validator is right and this page has a bug.

## Top level

| Field | Required | Type | Meaning |
|---|---|---|---|
| `version` | yes | `1` | Format version. |
| `title` | yes | string | Page title. The first word renders plain and the rest in the accent color, so `"Lantern task map"` shows "Lantern **task map**". |
| `nodes` | yes | array | Every milestone, gate, task, and issue. |
| `edges` | yes | array | Relations between nodes. `[]` when there are none. |
| `source` | no | string | Where the data came from. Shown in the footer. |
| `generatedAt` | no | string | When the adapter ran, in any format. Shown in the footer. |
| `kindNames` | no | object | Display names for the kinds, e.g. `{ "milestone": "WP", "gate": "checkpoint" }`. Used in the details panel, the footer, and the tray label. |

Unknown fields are errors at every level, so a misspelled field fails validation instead of silently doing nothing.

## Kinds

The **spine** is the milestones and gates: always drawn, laid out left to right along their `dep` and `gate` edges. **Tickets** are the tasks and issues hanging off the spine, filtered by the status chips.

| Kind | Role | Drawn as |
|---|---|---|
| `milestone` | A unit of planned work other work depends on: a phase, epic, work package, release. | Rounded pill with its `progress`. |
| `gate` | A review or checkpoint that runs after some milestones and informs later ones. | Chamfered box. |
| `task` | Planned work inside a milestone: a PR, a ticket, a sub-issue. | Three-line box. |
| `issue` | Unplanned work: a bug, a review finding, a question. | Three-line box; a red left bar when `tags` contains `bug`. |

## Node fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | string | Unique across all nodes. Keep it stable between runs: the same tracker object gets the same id every time. |
| `kind` | yes | string | One of the four kinds above. |
| `label` | yes | string | The short handle shown in bold: `M3`, `WP-16`, `#176`. |
| `title` | yes | string | One line of human text. Truncated on the map, shown in full in the panel. |
| `status` | yes | string | One of the nine statuses below. |
| `parent` | tickets only | string | The id of the milestone or gate this ticket hangs off. The page draws the dotted edge from it; there is no child edge type. A ticket with no parent and no edges goes to the unanchored tray. |
| `detail` | no | string | The one fact the status needs, shown on the ticket's middle line: the failing check, the PR number, what it is blocked on. |
| `queued` | no | boolean | Only with status `next`: planned and unblocked but not started. Drawn with a double dashed amber border and the word QUEUED. |
| `optional` | no | boolean | Dashed outline. For work that is planned but not required. |
| `tags` | no | string[] | Free-form. The first tag stands in for `detail` when there is none; `bug` adds the red bar. |
| `progress` | no | `{ done, total, unit? }` | Whole numbers, `done <= total`. Shown on milestone pills and gate labels (`M3 · 1/7 tasks`) and as a bar in the panel. |
| `url` | no | string | Link opened from the panel. Must start with `http://` or `https://`. |
| `urlLabel` | no | string | Link text. Defaults to "open in tracker". |
| `links` | no | `{ to, why, strong }[]` | Relations that are not structure: this node names, cites, or mentions another. Drawn only while either end is selected. `strong: true` (pink) for a declared or cited relation, `false` (grey) for a passing mention. `why` is shown in the panel. |
| `sections` | no | `{ heading, text?, items?, refs?, progress? }[]` | Adapter-defined panel content, rendered in order. Each needs at least one of: `text` (a paragraph), `items` (a bulleted list), `refs` (node ids, rendered as buttons), `progress` (a bar). |

## Statuses

The vocabulary is fixed. Adapters map every tracker state onto one of these; `AGENTS.md` step 3 is the worksheet.

| Status | Means | Drawn | Frontier view |
|---|---|---|---|
| `done` | Finished: merged, closed as completed. | Green; dashed on tickets. | hidden |
| `todo` | Planned, not started, still waiting on something. | Muted violet. | hidden |
| `next` | Planned and unblocked: everything it depends on is done. | Lavender. With `queued`, double dashed amber. | shown |
| `progress` | Someone is working on it: assigned and moving, a draft PR. | Amber. | shown |
| `gate` | Waiting on an automated gate: checks running, awaiting verification. | Amber, rounded, moving dashes. | shown |
| `review` | Waiting on people: PR open with checks green. | Teal. | shown |
| `failed` | An automated gate failed: CI red, deploy failed. | Red hexagon, pulsing. | shown |
| `blocked` | Explicitly blocked by something outside the map, or marked blocked. | Salmon. | shown |
| `open` | An open issue not yet planned into the work. | Pink. | shown |

The frontier view shows the whole spine plus tickets in the statuses marked shown. The status chips toggle each status individually.

## Edges

| Type | From → to | Meaning | Drawn |
|---|---|---|---|
| `dep` | any → any | `from` must finish before `to` can start. | Solid arrow. Spine `dep` edges implied by a longer path are not drawn. |
| `gate` | any → gate | The gate runs after `from`. | Dashed amber. |
| `advisory` | gate → any | The gate's outcome informs `to` without blocking it. | Dotted lavender, only while the gate is selected. |
| `resolves` | issue → any | Finishing `to` closes the issue. | Dotted. |

## Validation rules

Errors (the page and `bin/build.mjs` refuse the data):

- `version` is 1; `title` is a non-empty string; `nodes` and `edges` are arrays.
- No field outside the tables above, at any level.
- Every node has a unique non-empty `id`, a known `kind` and `status`, and non-empty `label` and `title`.
- `parent` appears only on tasks and issues, and names a milestone or gate.
- `queued` appears only with status `next`.
- `url` starts with `http://` or `https://`. The panel renders it as a link, and a map can load data from any `?data=` URL, so only web links pass.
- `progress` has whole-number `done` and `total` with `done <= total`.
- Every `links[].to`, `sections[].refs[]`, `edges[].from`, and `edges[].to` names an existing node.
- Every link has a non-empty `why` and a boolean `strong`.
- Every section has a `heading` and at least one of `text`, `items`, `refs`, `progress`.
- Edge types are `dep`, `gate`, `advisory`, `resolves`, with the endpoint kinds in the edge table. No edge connects a node to itself.
- `dep` edges form no cycle. The error prints the cycle's path.

Warnings (the data renders):

- A ticket with no `parent` and no edges. It is drawn in the unanchored tray, which is right for an issue nothing owns yet and a mistake for a task that lost its milestone.
