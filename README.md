# pi-workflow

Role-enforced, stage-gated AI workflow extension for [pi](https://pi.dev).
Implements a multi-role pipeline (Director, Planner, Scout, Architect, Engineer,
Reviewer, QA, Documenter) with hard-enforced write permissions per role, stage
sequencing, CLR (clarification request) gating, and retry-ruling escalation.

## Install

```bash
pi install git:github.com/mdpstory/pi-workflow
```

Or locally for a single project:

```bash
pi install -l git:github.com/mdpstory/pi-workflow
```

## What it provides

- 6 custom tools: `wf_init`, `wf_stage_start`, `wf_stage_complete`,
  `wf_clr_open`, `wf_clr_resolve`, `wf_status`, plus `wf_retry_bump` /
  `wf_retry_rule`.
- Per-role path allowlist (hard-blocks wrong-role writes).
- CLR gate (hard-blocks writes while a clarification is open).
- Stage sequencing (can't skip stages without an explicit trivial-task escape hatch).
- `progress.md` auto-rendered from `.workflow/state.json`.
- 8 role SKILL.md files under `skills/wf-*`.

Role is selected via the `PI_WORKFLOW_ROLE` env var (default `director`).

### Skipping stages by default

List stage names in a `skipStages` array in a JSON config file to auto-skip
them every run — no env var needed. Project config wins over global:

```json
// .pi/pi-workflow.json  (project, git-shareable)  — or ~/.pi/agent/pi-workflow.json (global)
{
  "skipStages": ["review", "testing"]
}
```

`wf_stage_start` auto-marks configured stages `done` and fast-forwards to the
next non-skipped stage (chaining through several in a row if needed).
`wf_stage_complete` also waives the artifact-exists check for these stages,
in case they're completed explicitly. This is separate from the per-call
`skip` param on `wf_stage_complete`, which is a one-off trivial-task escape
hatch logged to `decisions.md`.

(`PI_WORKFLOW_ROLE` and `PI_WORKFLOW_ID` stay env vars — they're per-process
identity, not static settings: multiple roles run concurrently as separate
subagent processes and can't share one config value.)

### Running multiple workflows in the same repo

Each pi session auto-namespaces its workflow by `PI_SESSION_ID` (falls back
to `"default"` only if that's also unset), so two independent sessions never
collide by default — each gets its own isolated `.workflow/<id>/` lock,
state, and artifacts. Set `PI_WORKFLOW_ID` explicitly only when you want to
pin a session (or a director's own subagents) to a *shared* workflow
namespace instead:

```bash
# session A — feature
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=feature-x pi ...

# session B — notifications, same repo, at the same time
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=notifications pi ...
```

Cross-namespace writes are hard-blocked for every role (even director), so a
`notifications` session can never touch `feature-x`'s artifacts or state.
When a director delegates to a subagent, it must pass both env vars:
`PI_WORKFLOW_ROLE=<role> PI_WORKFLOW_ID=<id>` (the `wf_stage_start` delegation
hint already includes this).

### `architecture.md` is shared across all workflow ids

Every other artifact (plan.md, tasks.md, research.md, review.md, ...) is a
property of one task and lives under `.workflow/<id>/artifacts/`.
`architecture.md` is different: it describes the codebase, not a single task,
so it lives once at `.workflow/shared/artifacts/architecture.md` and every
parallel workflow id reads and writes the same file. `wf_init` scaffolds it
there; `wf_stage_complete architecture` checks it there; the Architect role
(and Director) may write it regardless of `PI_WORKFLOW_ID`. This is
intentional and not subject to the cross-namespace block above.

## Testing

```bash
cd /tmp && rm -rf wf-pi-test && mkdir wf-pi-test && cd wf-pi-test && git init -q
cp -r /path/to/pi-workflow .pi/extensions/pi-workflow
PI_WORKFLOW_ROLE=director pi -p -e ./.pi/extensions/pi-workflow/index.ts "…"
```

See `spike-test.mjs` and `e2e-toy.mjs` for scripted coverage.
