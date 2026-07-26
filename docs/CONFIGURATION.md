# Configuration

## Config Files

### Project-level (git-shareable)

`.pi/pi-workflow.json`:

```json
{
  "skipStages": ["review", "testing"],
  "requireApproval": ["architecture"],
  "requirePreApproval": ["implementation"],
  "interceptReads": true,
  "autoResolveGateInUi": false,
  "requireDiscussionBeforeImpl": true
}
```

### Global (user-wide)

`~/.pi/agent/pi-workflow.json`:

```json
{
  "skipStages": [],
  "requireApproval": [],
  "requirePreApproval": [],
  "interceptReads": true,
  "autoResolveGateInUi": false,
  "requireDiscussionBeforeImpl": true
}
```

## Options

### `skipStages`

Stages to auto-skip in the pipeline.

```json
"skipStages": ["review", "testing"]
```

- `wf_stage_start` auto-marks these `done`
- Chains through consecutive skipped stages
- Open CLR stops the chain
- `wf_stage_complete` waives artifact check for these
- Safe to call again (no-op: `APPROVED (noop)`)

### `requireApproval`

Stages requiring human approval before completion.

```json
"requireApproval": ["architecture"]
```

- `wf_stage_complete` returns `AWAITING_HUMAN`
- Only `unassigned` session can resolve
- `reject` resets stage, appends to `decisions.md`
- `approve` marks done, advances

### `requirePreApproval`

Stages that need a human `wf_continue` verdict *before* they're allowed to start,
distinct from `requireApproval` which gates *completion* of a stage.

```json
"requirePreApproval": ["implementation"]
```

- When the upstream stage completes and the NEXT stage is in this list,
  `wf_stage_complete` returns `PRE_APPROVAL_REQUIRED` with a summary of what's
  done and what's coming next, instead of leaving the pipeline to auto-advance
- Resolved by `wf_continue({ stage, verdict, note? })` — human/unassigned session only
- `reject` resets the just-completed stage back to in-progress (framing was wrong,
  not the artifact) and requires a `note`, which becomes the correction brief
- `approve` lets the director proceed to `wf_stage_start` for the next stage
- An auto-skip chain (via `skipStages`) cannot start a pre-approval-gated stage
  unapproved — the chain stops and waits, same as it would without skipping
- Shares its resolution logic with `requireApproval` via `lib/gates.ts` (same
  architecture stamping, `decisions.md` entry, and bus notification on reject)

### `interceptReads`

Intercept `read` calls to return knowledge fragments.

```json
"interceptReads": true
```

- Default: `true`
- Full-file `read` returns fragments instead of raw body
- Pass `offset` or `limit` to bypass
- `bash` pager bypass blocked (`cat`/`head`/`tail`)
- Substituted content carries an explicit warning: re-read with `{ offset: 1 }` before
  editing, since `edit` against fragment text produces broken diffs
- Set `false` to disable

### `autoResolveGateInUi`

Whether the TUI confirm dialog may resolve a human gate inline.

```json
"autoResolveGateInUi": false
```

- Default: `false` (advisory)
- `false`: when `wf_stage_complete`/`wf_stage_start` returns `AWAITING_HUMAN` /
  `PRE_APPROVAL_REQUIRED`, the `tool_result` hook only *notifies*; the tool result passes
  through unchanged and the director's `wf_approve`/`wf_continue` call stays authoritative
  (which itself pops a confirm dialog). One gate path, no race.
- `true`: restores the old one-click behaviour — the dialog resolves the gate immediately and
  substitutes the tool result. Faster, but a later `wf_approve` from the model then fails with
  "no matching pending approval".

### `requireDiscussionBeforeImpl`

Require recorded Director↔User discussion before code is written.

```json
"requireDiscussionBeforeImpl": true
```

- Default: `true`
- `wf_stage_start("implementation")` is denied until `discussion.md` holds ≥ 2 entries
  (typically `kickoff` + `impl-scope`), logged via `wf_discuss`
- `wf_stage_complete(skip: ...)` (the trivial-task escape) is denied without a `trivial-scope`
  entry that carries the user's own `userSaid` words
- Set `false` for unattended/CI runs

## Environment Variables

### Identity (set by extension)

| Variable | Purpose |
|----------|---------|
| `PI_WORKFLOW_ROLE` | Current role (`director`, `engineer`, etc.) |
| `PI_WORKFLOW_ID` | Current workflow identifier |

These are:
- Set automatically for dispatched subagents
- **Reserved** - callers cannot pass them
- Stripped from caller-supplied `env` with warning

### Workflow Resolution Order

1. `PI_WORKFLOW_ID` env var
2. `.workflow/.active-id` marker file
3. Mint fresh if neither exists

## Agent Configuration

### Agent Definition Frontmatter

```yaml
---
name: engineer
workflowRole: engineer
description: Implementation specialist
model: claude-sonnet-4-5
tools: read, bash, write, edit, codegraph_search
---
```

### Agent Discovery

1. User-level: `~/.pi/agent/agents/*.md`
2. Project-level: `.pi/agents/*.md` (requires `agentScope`)
3. Bundled: `agents/*.md` in this package

Project agents require:
- `agentScope: "both"` or `"project"` in `subagent` call
- Confirmation unless `confirmProjectAgents: false`

### Subagent Dispatch

```typescript
// Single
subagent({ agent: "engineer", task: "implement X" })

// Parallel (max 8, 4 concurrent)
subagent({ tasks: [
  { agent: "engineer", task: "implement A" },
  { agent: "engineer", task: "implement B" }
]})

// Sequential
subagent({ chain: [
  { agent: "scout", task: "research X" },
  { agent: "planner", task: "plan X" }
]})
```

## Multiple Workflows

Run independent workflows in the same repo:

```bash
# Session A
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=feature-x pi

# Session B
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=notifications pi
```

Use `wf_new` to start additional workflows:

```typescript
wf_new({ label: "hotfix" })
```

Use `wf_list` to enumerate all workflows.