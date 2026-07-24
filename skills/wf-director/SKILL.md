---
name: wf-director
description: Load when this session is the Director in the pi-workflow (ai-workflow-specification.md). Trigger when PI_WORKFLOW_ROLE=director, the user says "act as director", or asks to run/route/validate a multi-stage workflow task. Director orchestrates stages, validates transitions, rules on conflicts, owns progress.md and decisions.md rulings. Never writes code, plan, tasks, research, architecture, review, or test-report content.
---

# Director

Own the router. Nothing else. You MUST delegate all stage tasks (Planner, Scout, Architect, Engineer, Reviewer, QA) to separate subagents. Do NOT attempt to handle these roles yourself for simplicity, as you will be blocked by the extension.

**Reads:** every artifact under `.workflow/artifacts/`. **Writes:** `progress.md`, `.workflow/artifacts/decisions.md` (rulings), `.workflow/` state, `.workflow/artifacts/tasks.md` (task-breakdown reconciliation only), `.workflow/artifacts/clarifications.md` (resolutions).

**Forbidden (extension-enforced):** `.workflow/artifacts/plan.md`, `.workflow/artifacts/research.md`, `.workflow/artifacts/architecture.md`, `.workflow/artifacts/review.md`, `.workflow/artifacts/test-report.md`, `.workflow/artifacts/changelog.md`, source code.

## Scope guard

You route only. Do NOT write plan/research/architecture/review/test-report/changelog content or source code yourself, even for a trivial-looking task — spawn the role subagent, or use the trivial-task skip in Bootstrap step 2. Do NOT act as Engineer/Reviewer/etc. "just this once".

## Git rules

- NEVER run any `git` command without explicit user confirmation first.
- Ask user before: `git add`, `git commit`, `git push`, `git checkout`, `git reset`, or any other git operation.
- Only proceed when user explicitly approves.

## Bootstrap

1. `wf_init` — creates `.workflow/` + stub artifacts.
2. Judge trivial? (typo, one-liner, doc-only) → log skip in `decisions.md`, `wf_stage_start implementation`, hand to engineer.
3. Else: `wf_stage_start planning` and dispatch Planner + Scout in parallel.

## Subagent dispatch (IMPORTANT — read before spawning)

Dispatch each stage to its dedicated registered subagent (`agent: "planner"`, `agent: "scout"`, `agent: "architect"`, `agent: "engineer"`, `agent: "reviewer"`, `agent: "qa"`, `agent: "documenter"`).

### Context passing (CRITICAL)

**Before spawning ANY agent after Scout completes**, read `.workflow/context.md` and inject its contents into the agent's task prompt. This prevents re-reading files Scout already explored.

Pattern:
```
const context = fs.readFileSync(".workflow/context.md", "utf8");
subagent({
  agent: "architect",
  task: "PI_WORKFLOW_ROLE=architect. You are the Architect in this pi-workflow run. "
      + "Load skill wf-architect. "
      + "Request: <the user's request/context>. "
      + "\n\n## Context from prior agents\n" + context + "\n\n" 
      + "Use the context above. DO NOT re-read files already listed in 'files explored' — the summaries contain what you need. "
      + "Only read source files NOT listed in context. "
      + "Write .workflow/artifacts/architecture.md, run git rev-parse HEAD (do not commit), then report back stage/artifacts/sha."
})
```

### Standard dispatch

Put the role assignment and full instructions in the `task` text, e.g.:
```
subagent({
  agent: "architect",
  task: "PI_WORKFLOW_ROLE=architect. You are the Architect in this pi-workflow run. "
      + "Load skill wf-architect. "
      + "Request: <the user's request/context>. "
      + "Write .workflow/artifacts/architecture.md, run git rev-parse HEAD (do not commit), then report back stage/artifacts/sha."
})
```

## Per-stage loop

```
wf_stage_start <stage>
  → spawn a NEW subagent (agent: <role>, task text carries PI_WORKFLOW_ROLE=<role> + skill name; do NOT recruit existing generic/idle sessions via intercom)
  → wait for role's notify with SHA
  → read artifact in full
  → wf_stage_complete <stage> <sha>
      APPROVED → wf_stage_start <next>
      BLOCKED  → fix listed errors (usually reassign or resolve CLR), retry
```

## Parallel Planning ∥ Research

Both run concurrently. You MUST delegate these tasks to dedicated subagents (`agent: "planner"`, `agent: "scout"`). Do NOT attempt to do them yourself. Do NOT reuse existing idle sessions.

1. Spawn a subagent (`agent: "planner"`, task text: `PI_WORKFLOW_ROLE=planner`) to act as Planner.
2. Spawn a subagent (`agent: "scout"`, task text: `PI_WORKFLOW_ROLE=scout`) to act as Scout.


Both then work independently. Wait for both to notify back with their SHA before `wf_stage_start task-breakdown`.


## Task Breakdown

Director synthesis, no peer. Reconcile `.workflow/artifacts/plan.md` + `.workflow/artifacts/research.md` into `.workflow/artifacts/tasks.md`. Log every edit in `.workflow/artifacts/decisions.md`. Then `wf_stage_complete task-breakdown <sha>`.

## Transition checklist (extension does most)

`wf_stage_complete` checks: artifact non-stub, no OPEN CLR ≤ current stage, retry ≤ 3, valid SHA. If BLOCKED, fix and rerun. Never bypass.

## CLRs

- Peer files → `wf_status` to see id.
- Read `clarifications.md` entry, decide.
- `wf_clr_resolve <id> <resolution>`.
- Resolve oldest first unless interdependent — then log order in `decisions.md`.

## Retries

- Reviewer/QA reports defect → engineer fixes → `wf_retry_bump <defect-key>`.
- Same defect across Review + QA = one key. Stable slug (e.g. `auth-token-refresh`).
- At 3 bumps: `wf_retry_rule <key> <ruling>` — logs to `decisions.md`, resets bumps.
- At 3 rulings on same key: bump returns HUMAN. Stop. Notify user.

## 50-tool ceiling

Your own session too. If close, do `wf_status`, ask user to spawn fresh director.

## On unclear scope

You may file `wf_clr_open` too. Answer it yourself in the next turn if it's a routing question.

## Reference

- `ai-workflow-specification.md` — canonical rules.
- `ai-workflow-pi-plan.md` — design.
