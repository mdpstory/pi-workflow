# pi-workflow

Role-enforced, stage-gated AI workflow extension for [pi](https://pi.dev).
Implements a multi-role pipeline (Director, Planner, Scout, Architect, Engineer,
Reviewer, QA, Documenter) with hard-enforced write permissions per role — director
included — stage sequencing, CLR (clarification request) gating, retry-ruling
escalation, an inter-agent message bus, and an optional human-in-the-loop approval
gate.

## Install

```bash
pi install git:github.com/mdpstory/pi-workflow
```

Or locally for a single project:

```bash
pi install -l git:github.com/mdpstory/pi-workflow
```

## What it provides

- Stage/state tools: `wf_init`, `wf_stage_start`, `wf_stage_complete`, `wf_status`,
  `wf_new`, `wf_list`.
- CLR tools: `wf_clr_open`, `wf_clr_resolve`.
- Retry-ruling escalation: `wf_retry_bump`, `wf_retry_rule`.
- Role claiming: `wf_claim`.
- Artifact writes: `wf_write_artifact`.
- Knowledge store (replaces the old shared `context.md`): `wf_knowledge_put`,
  `wf_knowledge_get`.
- Inter-agent message bus (replaces `intercom` for subagent coordination):
  `wf_msg_post`, `wf_msg_poll`, `wf_bus_digest`.
- Human-in-the-loop approval gate: `wf_approve`.
- Token-economic director polling: `wf_artifact_summary`.
- Per-role path allowlist, hard-blocked for **every** role including director —
  there is no convention-only/discipline-required category left.
- CLR gate (hard-blocks writes while a clarification is open).
- Stage sequencing (can't skip stages without an explicit trivial-task escape hatch
  or `skipStages` config).
- 8 role SKILL.md files under `skills/wf-*`.

## Role model

Three states, resolved fresh on every call:

- **unassigned** — no `PI_WORKFLOW_ROLE` env var, no in-process `wf_claim` call.
  Only `wf_status`, `wf_claim`, and (if a stage awaits approval) `wf_approve` are
  meaningful; nothing is gated.
- **director** — `PI_WORKFLOW_ROLE=director` in env, OR the session calls
  `wf_claim({ role: "director" })` (in-process only, never persisted, never
  inherited by anything the director spawns). Loading the `wf-director` skill by
  itself does NOT make a session the director — the skill's first step is
  `wf_claim`.
- **`<role>`** — `PI_WORKFLOW_ROLE=<role>` in env; how a dispatched subagent gets
  its identity: `subagent({ agent, env: { PI_WORKFLOW_ROLE, PI_WORKFLOW_ID }, task })`.

Once any role exists (director included), the write/edit hook and the 50-call
ceiling activate uniformly. Director's own allowlist
(`decisions.md`/`tasks.md`/`clarifications.md` only — no source, no
`architecture.md`, no other artifacts) is code-enforced exactly like every other
role, not left to skill-file discipline.

### `wf_approve` is human-only

Refuses to run for any claimed/env role, director included — only an
`unassigned` session may call it. A director cannot rubber-stamp its own
approval-required stage by unsetting its env var either, since at that point
it's no longer the director and can't call `wf_stage_complete`.

## Config

```json
// .pi/pi-workflow.json  (project, git-shareable)  — or ~/.pi/agent/pi-workflow.json (global)
{
  "skipStages": ["review", "testing"],
  "requireApproval": ["architecture"],
  "interceptReads": false
}
```

- **`skipStages`** — `wf_stage_start` auto-marks these `done` and fast-forwards to
  the next non-skipped stage (chains through several in a row). An open CLR at or
  before a stage stops the chain there. `wf_stage_complete` waives the
  artifact-exists check for these stages and no-ops safely (`APPROVED (noop)`) if
  called again for a stage already auto-done. Separate from the per-call `skip`
  param on `wf_stage_complete` (one-off trivial-task escape hatch, logged to
  `decisions.md`).
- **`requireApproval`** — stages that need a human `wf_approve` call before they
  can be marked done. See "Human-in-the-loop approval gate" below.
- **`interceptReads`** (default `false`) — when true, a full-file `read` of a
  source with fresh knowledge fragments returns the fragments instead of the raw
  body. See "Knowledge store" below.

(`PI_WORKFLOW_ROLE`/`PI_WORKFLOW_ID` stay env vars, not config — they're
per-process identity: multiple roles run concurrently as separate subagent
processes and can't share one config value.)

## Running multiple workflows in the same repo

Workflow id resolves: `PI_WORKFLOW_ID` env var → `.workflow/.active-id` marker
file (written on first resolution, read on every later call, so killing and
restarting a bare director session resumes the *same* workflow) → mint fresh.
Call `wf_new` (optionally with a `label`) to start a genuinely new, independent
workflow — mints a fresh id and overwrites the marker. `wf_list` enumerates every
`.workflow/<id>/` namespace, with stage and director-lock liveness, for any role.

```bash
# session A — feature
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=feature-x pi ...

# session B — notifications, same repo, at the same time
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=notifications pi ...
```

Cross-namespace writes are hard-blocked for every role (even director). A
director delegating to a subagent must pass both env vars via the subagent's
`env` param: `{ PI_WORKFLOW_ROLE: "<role>", PI_WORKFLOW_ID: "<id>" }` — not a
task-text convention.

## `architecture.md` is shared across all workflow ids

Every other artifact (plan.md, tasks.md, research.md, review.md, ...) is a
property of one task and lives under `.workflow/<id>/artifacts/`.
`architecture.md` describes the codebase, not a single task, so it lives once at
`.workflow/shared/artifacts/architecture.md` and every parallel workflow id reads
and writes the same file. Only the Architect role may write it — **Director is
explicitly blocked** and must delegate. This shared-artifact reach is intentional
and not subject to the cross-namespace block above.

**Architecture stage is never in `skipStages`** — it's auto-skipped
conditionally instead: `wf_stage_complete architecture` stamps a
`<!-- generated-at-sha: <sha> -->` marker on the first line of `architecture.md`,
and the next `wf_stage_start architecture` runs a cheap
`git diff --quiet <stamped> <HEAD>` (excluding `.workflow/`, `node_modules/`) to
check whether anything changed since that sha. No diff → auto-marked done,
Architect not invoked. Diff found (or no git repo, or no stamp yet) → Architect
runs normally.

## Knowledge store (replaces `context.md`)

Instead of one shared, append-only `context.md` every agent had to read/re-read
in full, agents call `wf_knowledge_put({ file, note, scope })` per source file
analyzed, and `wf_knowledge_get({ file })` before reading a file another agent
may already have analyzed. Fragments are immutable and never collide (filename
includes pid + timestamp + role), so no locking is needed even under concurrent
parallel Engineers. `scope: "general"` fragments live under
`.workflow/shared/knowledge/` (durable, repo-wide, survives across workflow
ids); `scope: "task"` fragments live under `.workflow/<id>/knowledge/`
(disposable, this workflow only). `wf_knowledge_get` filters to fragments whose
recorded `mtime`/`size` still match the file on disk — stale fragments are
excluded and counted, never silently served as current.

**Optional read interception (`interceptReads`):** with `"interceptReads": true`
in config, a full-file `read` of a source that has fresh fragments transparently
returns the fragment(s) instead of the raw body — the token win, enforced by the
`tool_result` hook (which, unlike `tool_call`, can substitute a tool's result).
It is **off by default** because it changes `read` semantics; passing an
`offset` or `limit` to `read` is the escape hatch that always yields raw source.
Even with the flag off, `wf_knowledge_get` is the explicit path agents call
before reading; every role skill documents this.

## Inter-agent message bus (replaces `intercom` for subagent coordination)

`intercom` addresses interactive sessions by discoverable name and messages die
with the process — neither fits a dispatched, non-interactive subagent well.
`wf_msg_post({ to, body })` / `wf_msg_poll({ since? })` write/read plain
per-role JSONL files under `.workflow/<id>/bus/<role>.jsonl` (`to: "all"` is a
broadcast inbox every role also polls). Survives process death, fully auditable —
`wf_bus_digest` (director-only) returns the whole transcript, oldest first,
across every role.

## Human-in-the-loop approval gate

Stages listed in `requireApproval` do not get marked done by
`wf_stage_complete` even if the checklist passes — it returns `AWAITING_HUMAN`
with a summary, stored as the pending approval. Only an `unassigned` (human)
session can resolve it: `wf_approve({ stage, sha, verdict: "approve"|"reject",
note? })`. `reject` resets the stage to `in-progress` and appends the human's
note to `decisions.md` as a correction brief; `approve` marks it done and
advances, same as a normal `wf_stage_complete` APPROVED.

## Token-economic director polling

`wf_artifact_summary({ artifact })` extracts just headings and verdict/DRAFT
lines from an artifact instead of returning the full file — the director's skill
uses this for routine per-stage polling and only reads an artifact in full on
BLOCKED or right before presenting an AWAITING_HUMAN summary to the user.

## Retry keys span stages, not just the current one

`wf_retry_bump`/`wf_retry_rule` counters are keyed purely by the defect/CLR
`key` string (`state.rulings[key]`), never by whichever stage happens to be
"current" at call time. The same defect key is meant to span Review and QA (a
bug caught by Reviewer, still failing when QA re-tests, is one key, one
counter) — `wf_stage_complete`'s retry cap check (`bumps >= 3`) reads that keyed
counter directly rather than a per-stage mirror. At 3 rulings on the same key,
a further bump escalates to `HUMAN` and stops.

## Concurrency

- **Director lock**: PID-liveness based (checked via signal 0, not a heartbeat
  timestamp), acquired with an atomic exclusive-create (`wx` flag) to avoid a
  check-then-create race between two director processes starting at once.
- **Knowledge fragments**: no locking needed — each fragment is its own
  immutable file with a unique name.
- **Message bus**: single-syscall atomic appends per role file.
- **Cross-namespace**: writes to another workflow id's `.workflow/<id>/` are
  hard-blocked for every role, so two workflows in the same repo never race on
  each other's state, even without a lock.

## Testing

```bash
cd /tmp && rm -rf wf-pi-test && mkdir wf-pi-test && cd wf-pi-test && git init -q
cp -r /path/to/pi-workflow .pi/extensions/pi-workflow
PI_WORKFLOW_ROLE=director pi -p -e ./.pi/extensions/pi-workflow/index.ts "…"
```

See `spike-test.mjs`, `concurrency-test.mjs`, `knowledge-test.mjs`, and
`e2e-toy.mjs` for scripted coverage.
