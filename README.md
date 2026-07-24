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

### Running multiple workflows in the same repo

Set `PI_WORKFLOW_ID` (default `"default"`) to namespace a workflow. Each id
gets its own isolated `.workflow/<id>/` lock, state, and artifacts, so two
independent features can each run their own director + role pipeline in the
same repo/session pair at the same time without colliding:

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

## Testing

```bash
cd /tmp && rm -rf wf-pi-test && mkdir wf-pi-test && cd wf-pi-test && git init -q
cp -r /path/to/pi-workflow .pi/extensions/pi-workflow
PI_WORKFLOW_ROLE=director pi -p -e ./.pi/extensions/pi-workflow/index.ts "…"
```

See `spike-test.mjs` and `e2e-toy.mjs` for scripted coverage.
