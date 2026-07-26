# Configuration

## Config Files

### Project-level (git-shareable)

`.pi/pi-workflow.json`:

```json
{
  "skipStages": ["review", "testing"],
  "requireApproval": ["architecture"],
  "interceptReads": true
}
```

### Global (user-wide)

`~/.pi/agent/pi-workflow.json`:

```json
{
  "skipStages": [],
  "requireApproval": [],
  "interceptReads": true
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

### `interceptReads`

Intercept `read` calls to return knowledge fragments.

```json
"interceptReads": true
```

- Default: `true`
- Full-file `read` returns fragments instead of raw body
- Pass `offset` or `limit` to bypass
- `bash` pager bypass blocked (`cat`/`head`/`tail`)
- Set `false` to disable

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