# Tracker recipes

Starting mappings from common trackers to the task-map format. Each section covers the same five decisions `AGENTS.md` walks through: spine, tickets, statuses, edges, detail and links.

The GitHub section was written against calls that ran; the Linear and Jira field names are from their public APIs as of 2026 and unverified here. Confirm each field against the tracker's current API reference before depending on it, and treat any mismatch as a fix to this file.

For a tracker not listed, read the GitHub section as the worked example, then the spreadsheet section for the minimum an adapter needs.

## GitHub (Issues, pull requests, Projects)

**Spine.** Pick one:

- Milestones (`gh api repos/OWNER/REPO/milestones --paginate`) as `milestone` nodes, `progress` from `closed_issues` of `closed_issues + open_issues`. Milestones carry no dependencies of their own; order them with `dep` edges from `due_on`, or from dependencies between the issues inside them, and say which in `source`.
- Parent issues with sub-issues, when the team plans that way: the parent is the milestone, its sub-issues the tasks. GraphQL `issue { parent { number } subIssues(first: 100) { nodes { number } } }`.
- Issues carrying a label such as `checkpoint` or `review` become `gate` nodes.

**Tickets.** Issues in a milestone, or sub-issues of a parent, become `task` nodes with `parent` set. Open issues outside any milestone become `issue` nodes: `parent` unset, `tags` from labels.

Pull requests have two good shapes:

- Fold each PR into the issue it closes: the issue's `status` and `detail` come from the PR. `gh pr list --state all --json number,title,state,isDraft,url,statusCheckRollup,closingIssuesReferences`.
- One `task` node per PR, with a `resolves` edge from the issue it closes. Better when a milestone's work is mostly PRs, as with a PR-per-step plan.

**Statuses.**

| GitHub state | Status | `detail` |
|---|---|---|
| Issue closed as completed, or PR merged | `done` | |
| Issue closed as not planned, or PR closed unmerged | leave the node off the map | |
| PR open, the latest run of any check concluded `FAILURE`, `ERROR`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, or `STARTUP_FAILURE` | `failed` | failing check names |
| PR open, the latest run of a check not yet `COMPLETED` | `gate` | running check names |
| PR open as draft | `progress` | `draft` |
| PR open, checks green | `review` | `PR #n` |
| Issue open with an open `blocked_by` dependency | `todo` | |
| Issue open, labeled blocked | `blocked` | the label, or the comment explaining it |
| Issue open, assigned, no PR | `progress` | assignee |
| Issue open, unassigned, nothing blocking | `next` with `queued: true` | `not started` |
| Issue open outside the planned work | `open` | first label |

`statusCheckRollup` lists every run of a check on the PR's head commit, including runs a later one replaced: a manual re-run, or a workflow with `cancel-in-progress` that fires again when the PR is edited leaves a `CANCELLED` run behind each time. Keep only the run with the newest `startedAt` for each workflow and check name before applying the table, as `gh pr checks` does. Otherwise a PR that GitHub shows green stays `failed` on the map for as long as that commit is its head. A commit status (`StatusContext`) has no workflow or check name, so key it by its `context`; keyed by the missing names, every status collapses into one entry and a failing one can vanish.

When the team keeps a Projects board, its Status column is usually a better source than inference: GraphQL `projectV2 { items { content { ... on Issue { number } } status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }`. Map each column in the worksheet.

**Edges.** `GET /repos/OWNER/REPO/issues/N/dependencies/blocked_by` lists what blocks issue N: a `dep` edge from each blocker to N. A gate issue's `blocked_by` list gives its `gate` edges.

**Detail and links.** `#123` references in a body are weak links. A `Fixes #123` or `Closes #123` becomes a `resolves` edge. A convention the team already writes, such as a marker comment naming the owning milestone, is a strong link.

## Linear

**Spine.** Projects, or project milestones within a project, as `milestone` nodes. Count issues by state type for `progress`.

**Tickets.** Issues become tasks with `parent` set to their project or project milestone. Issues in triage, or outside any project, become `issue` nodes.

**Statuses.** Each workflow state has a `type`:

| Linear `state.type` | Status |
|---|---|
| `completed` | `done` |
| `canceled` | leave the node off the map |
| `started` | `progress`, or `review` when the state's name marks review |
| `unstarted` | `next` with `queued: true` when nothing open blocks it, otherwise `todo` |
| `backlog` | `todo` |
| `triage` | `open` |

Teams rename and add states freely; map each state name in the worksheet rather than trusting the type alone.

**Edges.** `issue { relations { nodes { type relatedIssue { identifier } } } }`: a `blocks` relation is a `dep` edge from this issue to the related one. `related` and `duplicate` are weak links. Read `inverseRelations` too, or each relation appears from one side only.

**PR state.** Linear's GitHub integration attaches pull requests to issues. Check and review state is most reliable read from GitHub directly, by the attachment's URL.

## Jira

**Spine.** Epics, or fix versions (releases), as `milestone` nodes.

**Tickets.** `POST /rest/api/3/search/jql` with a JQL query, requesting `summary`, `status`, `issuetype`, `parent`, `fixVersions`, `labels`, `issuelinks`. Issues whose `parent` is an epic become its tasks. Bugs outside any epic become `issue` nodes.

**Statuses.** Each status has a category, `status.statusCategory.key`:

| Jira category | Status |
|---|---|
| `done` | `done` |
| `indeterminate` | `progress`, refined by status name: a review status to `review`, a blocked status to `blocked` |
| `new` | `next` with `queued: true` when no open issue blocks it, otherwise `todo` |

**Edges.** `issuelinks` entries of type `Blocks`: an `outwardIssue` means this issue blocks that one, a `dep` edge from this issue to it; an `inwardIssue` means that one blocks this, a `dep` edge the other way. `Relates` links are weak links.

**PR state.** Jira's development panel is not a stable public API. Read check and review state from the code host.

## Spreadsheet or CSV

The smallest workable adapter reads one row per node with the columns `id`, `kind`, `label`, `title`, `status`, `parent`, `depends_on`, writing a `dep` edge for each id in `depends_on`. Every other field is optional. A project tracked in a spreadsheet can use the map with a twenty-line script.
