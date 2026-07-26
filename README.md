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
  `wf_msg_post`, `wf_msg_poll`, `wf_msg_wait`, `wf_bus_digest`. Fire-and-forget by
  nature — see `docs/MESSAGE-BUS.md` for the honest limits.
- Human-in-the-loop approval gate: `wf_approve`, `wf_continue` (post-stage-complete
  pre-approval gate for the next stage).
- Director's persistent first-person memory: `wf_intent` — survives session kill /
  early abort so a resumed director recovers the original user request and its
  own routing POV.
- Durable Director↔User discussion transcript: `wf_discuss` — see the design
  invariant below.
- In-flight dispatch registry: `wf_dispatch_note` — a resumed director sees what the
  dead session already spawned instead of double-dispatching it.
- Token-economic director polling: `wf_artifact_summary`.
- Per-role path allowlist, hard-blocked for **every** role including director —
  there is no convention-only/discipline-required category left.
- CLR gate (hard-blocks writes while a clarification is open).
- Stage sequencing (can't skip stages without an explicit trivial-task escape hatch
  or `skipStages` config).
- 8 role SKILL.md files under `skills/wf-*`.

## Design invariant: the Director always discusses

The Director is the **only** role that talks to the user, and it must actually have the
conversation — never fire-and-forget. Subagents execute; the Director discusses.

Because chat history dies with the process, every exchange is recorded with `wf_discuss` into
`.workflow/<id>/discussion.md`, which `wf_status` replays (last 3 entries) on resume. Six
mandated checkpoints: `kickoff`, `plan-review`, `arch-choice`, `impl-scope`, `review-verdict`,
`final-signoff` (plus `trivial-scope` before any skip).

This is enforced in code, not just prose:

- `wf_stage_start("implementation")` is denied below 2 discussion entries
  (`requireDiscussionBeforeImpl`, default true).
- The trivial-task skip is denied without a `trivial-scope` entry quoting the user.
- A headless (`pi -p`) director relaying a human gate verdict must pass `note` with the
  user's exact words; it is quoted into `decisions.md`. No note, no approval.
- Re-firing an identical denied `wf_stage_start`/`wf_stage_complete` 3× in 30s is blocked —
  read the denial and talk to the user instead of looping.

`wf_status` is the resume contract: computed **NEXT ACTION** line, in-flight subagents, unread
bus traffic (with a rejection-brief flag), last 3 discussion entries, and the director memory
log.

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
- **`<role>`** — `PI_WORKFLOW_ROLE=<role>` in env; set automatically for a dispatched
  subagent from the agent's own `workflowRole` frontmatter (`agent: "engineer"` →
  engineer). Callers do not pass role/id via `env` at all — `PI_WORKFLOW_ROLE` and
  `PI_WORKFLOW_ID` are reserved keys, silently stripped from caller-supplied `env`
  (with a warning surfaced in the subagent result) to stop a caller from handing a
  child director permissions or resetting the recursion depth. Just
  `subagent({ agent, task })`.

Once any role exists (director included), the write/edit hook and the per-stage tool
ceiling activate uniformly (50 calls per stage; 120 during `implementation`, where the
director dispatches and polls many parallel engineers inside a single stage). Director's own allowlist
(`decisions.md`/`clarifications.md` only — no source, no stage artifact at all,
`tasks.md` included) is code-enforced exactly like every other
role, not left to skill-file discipline.

### `wf_approve` / `wf_continue` are human-gated

Refuse to run for any dispatched agent role. Callable by an `unassigned` session,
or by the director session acting purely as a relay for the user's explicit verdict
— the director has no other channel to hand the human a tool call, so without the
relay the pre-approval gate deadlocks. Skill rule: no user message, no call.

## Config

```json
// .pi/pi-workflow.json  (project, git-shareable)  — or ~/.pi/agent/pi-workflow.json (global)
{
  "skipStages": ["review", "testing"],
  "requireApproval": ["architecture"],
  "interceptReads": true
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
- **`interceptReads`** (default `true`) — when true, a full-file `read` of a
  source with fresh knowledge fragments returns the fragments instead of the raw
  body. See "Knowledge store" below. Set to `false` to restore old behavior.

(`PI_WORKFLOW_ROLE`/`PI_WORKFLOW_ID` stay env vars, not config — they're
per-process identity: multiple roles run concurrently as separate subagent
processes and can't share one config value. They are set by the extension
itself when spawning a subagent, never by the caller — see "Role model" above.)

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
may already have analyzed. Omit `file` to get a coverage table (`path | scope |
fragments | fresh?`) of every file already analyzed instead of guessing names
one at a time. Fragments are immutable and never collide (filename
includes pid + timestamp + role), so no locking is needed even under concurrent
parallel Engineers. Retrieval keeps only the newest 3 fresh fragments per scope
(older ones are noted as omitted, byte-identical dupes are dropped) so N agents
analyzing the same file don't multiply retrieval tokens by N forever.
`scope: "general"` fragments live under `.workflow/shared/knowledge/` (durable,
repo-wide, survives across workflow ids); `scope: "task"` fragments live under
`.workflow/<id>/knowledge/` and **disappear when the workflow id does** — a new
workflow id starts cold on task notes; promote durable facts to `general`
instead. `wf_knowledge_get` filters to fragments whose recorded `mtime`/`size`/
`hash` still match the file on disk (mtime+size are a cheap pre-filter, the sha1
content hash is the actual verdict — a same-size edit or a git checkout that
preserves mtime cannot be served as fresh) — stale fragments are excluded and
counted, never silently served as current.

**Read interception (`interceptReads`, default `true`):** a full-file `read` of
a source that has fresh fragments transparently returns the fragment(s) instead
of the raw body — enforced by the `tool_result` hook (which, unlike
`tool_call`, can substitute a tool's result). Passing an `offset` or `limit` to
`read` is the escape hatch that always yields raw source (e.g. right before an
edit). The `tool_call` hook also blocks the `bash` pager bypass (`cat`/`head`/
`tail`/`sed -n` on a path with fresh fragments) with a hint to use `read` or
`wf_knowledge_get` instead — `grep`/other bash reads are unaffected. Set
`interceptReads: false` to disable both and fall back to skill-file discipline
alone.

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

## `subagent` tool

Merged in from the former standalone `pi-subagent` package (now retired — see
"History" below). Delegates a task to a separate `pi` subprocess with its own
context window, system prompt, and tool/model config.

```
subagent/
├── agents.ts   # discovery: ~/.pi/agent/agents/*.md, .pi/agents/*.md
├── format.ts   # display formatting (tokens, tool calls, diffs, live blocks)
├── run.ts      # process spawn/env lifecycle, buildChildEnv, RESERVED_ENV_KEYS
└── tool.ts     # the registered `subagent` tool (single/parallel/chain modes)
```

**Modes** — `{ agent, task }` (single), `{ tasks: [...] }` (parallel, max 8, 4
concurrent), `{ chain: [...] }` (sequential, `{previous}` placeholder).

**Identity, not env passthrough**: `subagent({ agent, task })` — the child's workflow
identity is derived internally (`buildChildEnv`) from the dispatched agent's own
`workflowRole` frontmatter and the inherited/marker-resolved workflow id, never from a
caller-supplied `env`. `RESERVED_ENV_KEYS` in `run.ts` strips `PI_WORKFLOW_ROLE`,
`PI_WORKFLOW_ID`, and the recursion-depth keys out of any caller-supplied `env` before
merging it, and `buildChildEnv` reports which keys were dropped so the subagent result
surfaces a visible warning instead of silently doing nothing. A depth ceiling separately
prevents runaway recursive dispatch.

**Agent personas**: `agents/*.md` (architect, documenter, engineer, planner, qa,
reviewer, scout, worker — director intentionally excluded, see the comment in
`agents/director.md`) ship in this package and are loaded straight from it by
`subagent/agents.ts` (pi has no manifest field for agents, so the extension
discovers its own bundled dir). No symlinks into `~/.pi/agent/agents/` are
needed; same-named user or project agents still override the bundled ones.
`prompts/*.md` (`/implement`,
`/scout-and-plan`, `/implement-and-review`) ship via the `"prompts"` field in
`package.json`.

**Security model**: only user-level agents (`~/.pi/agent/agents/`) load by
default. Project-local agents (`.pi/agents/*.md`) are repo-controlled prompts
and require `agentScope: "both"` or `"project"` — only for trusted repos —
and prompt for confirmation unless `confirmProjectAgents: false`.

### History

Previously a separate package (`git:github.com/mdpstory/pi-subagent`). Merged
into this repo so the workflow tools and the delegation mechanism they depend
on (the DELEGATE hint in `wf_stage_start` calls `subagent({ agent: "<role>", ... })`)
ship as one installable unit instead of two packages that had to be kept in
sync by hand. `pi-subagent`'s own `wf_write_artifact` was dropped in the merge
in favor of this package's (role + CLR gated, shared-artifact routing) — see
`decisions.md` history / the merge commit for details.

## Testing

```bash
cd /tmp && rm -rf wf-pi-test && mkdir wf-pi-test && cd wf-pi-test && git init -q
cp -r /path/to/pi-workflow .pi/extensions/pi-workflow
PI_WORKFLOW_ROLE=director pi -p -e ./.pi/extensions/pi-workflow/index.ts "…"
```

See `spike-test.mjs`, `concurrency-test.mjs`, `knowledge-test.mjs`, and
`e2e-toy.mjs` for scripted coverage.
