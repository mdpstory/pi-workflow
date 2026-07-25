# pi-workflow rework — summary

Implements `plan.md` end to end: enforcement made real (not convention-only),
token-economic director, no double-reads, agent-to-agent messaging, human
approval gate, plus all P5 correctness fixes.

## What changed

### `index.ts` — full rewrite (was ~partial/convention-only, now code-enforced)

- **Role model (P0-2)**: three states — `unassigned` / `director` / `<role>`.
  `wf_claim(role)` sets an in-process var only, never persisted, never
  inherited by subagents. `workflowActive()` = `role !== "unassigned"`; gating
  (write/edit hook, 50-call ceiling) activates uniformly the moment any role
  exists — director's own allowlist is now hard-enforced like every other
  role, closing the old "director is convention-only" gap.
- **Workflow id resolution (P0-3)**: `PI_WORKFLOW_ID` env → `.workflow/.active-id`
  marker (enables resume after restart) → mint fresh. New tools `wf_new`
  (explicit fresh id) and `wf_list` (enumerate all ids + stage + lock
  liveness).
- **Env-based subagent identity (P0-1)**: role/id passed via `subagent(...)`'s
  `env` param, not a task-text prefix convention (deleted everywhere it
  appeared: skills, README, delegation hints).
- **Knowledge store (P1-1, replaces `context.md`)**: `wf_knowledge_put` /
  `wf_knowledge_get`, immutable per-file fragments (`<pid>-<ts>-<role>.md`, no
  locking needed), `general` scope (`.workflow/shared/knowledge/`, durable
  across workflow ids) vs `task` scope (`.workflow/<id>/knowledge/`,
  disposable). Freshness checked via recorded `mtime`+`size` vs the file on
  disk; stale fragments excluded and counted, never silently served as
  current.
- **P1-2 (mechanical read interception) — IMPLEMENTED via the `tool_result`
  hook.** `tool_call` is block-only, but `tool_result` *can* substitute a
  tool's content. Opt-in through config `interceptReads` (default off, since it
  changes `read` semantics). A full-file `read` of a source with fresh
  (mtime+size matching) fragments returns the fragment(s) instead of the raw
  body; passing `offset`/`limit` is the escape hatch for raw source. Covered by
  section E of `knowledge-test.mjs`. `wf_knowledge_get` remains the explicit
  path regardless of the flag.
- **`context.md` retired (P1-3)**: fully removed, not kept as a compat shim —
  `wf_context_append` no longer exists; replaced everywhere by
  `wf_knowledge_put`/`get`.
- **Agent message bus (P2)**: `wf_msg_post`, `wf_msg_poll`, `wf_bus_digest`
  (director-only digest). Per-role JSONL files under `.workflow/<id>/bus/`,
  single atomic append per message. Replaces `intercom` for
  subagent↔subagent / subagent↔director coordination — intercom targets
  discoverable interactive sessions and its messages die with the process;
  the bus survives and is fully auditable after a run.
- **Human approval gate (P3)**: config `requireApproval: [stage, ...]`.
  `wf_stage_complete` on a gated stage returns `AWAITING_HUMAN` (with a
  summary) instead of marking done. New `wf_approve({ stage, sha, verdict,
  note? })`, callable only by `unassigned` (human) role — a director cannot
  self-approve even by manipulating its own env, since at that point it isn't
  the director anymore either. `reject` resets the stage to `in-progress` with
  the note appended to `decisions.md` as a correction brief.
- **Director token diet (P4)**: `wf_artifact_summary({ artifact })` — extracts
  headings + verdict/DRAFT lines only. Director skill updated to poll with
  this and read full artifacts only on `BLOCKED` or right before presenting an
  `AWAITING_HUMAN` summary. Director no longer embeds full knowledge dumps
  into every subagent dispatch prompt — targeted `wf_knowledge_get` calls per
  file instead.
- **P5 correctness fixes** (all nine, `C1`–`C9`):
  - `C1` auto-skip/`wf_stage_complete` infinite-BLOCKED loop — fixed;
    `wf_stage_complete` now no-ops with `APPROVED (noop)` for a stage already
    marked done by auto-skip, instead of demanding a fake sha.
  - `C2` retry off-by-one — unified to `>= 3` in both the bump-warning and the
    stage-complete block.
  - `C3` ceiling exemption branch order bug — restructured so the hard-stop
    (`cap+5`) check runs first and independently, exempting only
    `wf_clr_open`/`wf_msg_post`; soft ceiling (50) exempts `write`/`edit`/
    `wf_clr_open`/`wf_msg_post`/`intercom`.
  - `C4` stub-content false positive (`_empty_` matched anywhere in file) —
    replaced with an exact-shape regex (`STUB_RE`).
  - `C5` `wf_init` silently touching `.gitignore` — now prompts via
    `ctx.ui.confirm` when available; matches both `.workflow` and
    `.workflow/` forms so it doesn't double-append.
  - `C6` dead `blocked`/`retry`/`failed` stage states — `wf_clr_resolve` now
    restores a stage from `blocked` back to `in-progress` once no other CLR
    blocks it (previously write-only, never consulted).
  - `C7` stale `heartbeatAt` field — dropped entirely; liveness is PID-only
    (checked via signal 0), consistent with how it actually behaved.
  - `C8` README described unimplemented/inert behavior — fully rewritten (see
    below).
  - `C9` `wf_write_artifact` missing from `index.ts` despite being referenced
    by skills — added as a real registered tool.
- **Shared `architecture.md`**: unchanged in spirit from before, reconfirmed —
  lives at `.workflow/shared/artifacts/architecture.md`, only the architect
  role may write it, director hard-blocked, git-sha stamp comment +
  `git diff --quiet` used to auto-skip re-generation when nothing changed.
- **Cross-namespace protection**: `wfNamespaceRel()` classifies every path as
  own/foreign/shared; foreign paths are denied regardless of role, so
  concurrent `PI_WORKFLOW_ID` workflows in the same repo can't collide even
  without a lock.

### Skill files — all 8 `skills/wf-*/SKILL.md` updated

- `wf-director`: added `wf_claim({ role: "director" })` as step 0; env-based
  subagent dispatch examples (`env: { PI_WORKFLOW_ROLE, PI_WORKFLOW_ID }`,
  never task-text prefix); `wf_knowledge_get` for targeted context instead of
  a full `context.md` dump before spawning; `wf_artifact_summary` for routine
  polling with full-read reserved for BLOCKED/human-gate; parallel-engineer
  coordination via `wf_msg_post`/`wf_msg_poll`/`wf_bus_digest` instead of
  intercom; explicit human approval gate procedure (present `AWAITING_HUMAN`
  summary, wait for `wf_approve`, cannot self-approve); `wf_new`/`wf_list`
  documented in Bootstrap.
- `wf-planner`, `wf-scout`, `wf-architect`, `wf-engineer`, `wf-reviewer`,
  `wf-qa`, `wf-documenter`: every `context.md` read/`wf_context_append`
  reference replaced with `wf_knowledge_get`/`wf_knowledge_put` (scope
  `general` for durable repo facts, `task` for request-specific notes);
  `wf-engineer`'s peer-coordination section switched from `intercom` to
  `wf_msg_post`/`wf_msg_poll`, with rationale (subagents aren't addressable
  interactive sessions; the bus survives process exit and intercom doesn't).

### `README.md` — rewritten

Reflects the new three-state role model, full tool list (16 tools), config
(`skipStages` + `requireApproval`), workflow id resolution/`wf_new`/`wf_list`,
knowledge store (with the P1-2 limitation called out explicitly), the message
bus, the human approval gate, token-economic director polling, retry-key
semantics, and a concurrency section describing the actual (lock, fragment,
bus, cross-namespace) guarantees instead of the old inert/aspirational claims.

### Tests

- `spike-test.mjs` — unmodified, passing (director init, non-director denied,
  role path allowlist).
- `concurrency-test.mjs` — one path reference fixed (`context.md` →
  `clarifications.md`, since `context.md` no longer exists), passing
  (namespace isolation, lock non-blocking across ids, cross-namespace hard
  block, live-lock re-block).
- `context-append-test.mjs` → renamed/rewritten as `knowledge-test.mjs`,
  covering `wf_knowledge_put`/`get`: concurrent puts don't clobber, unassigned
  denied, staleness detection via mtime/size, general-vs-task scope routing.
  Passing.
- `e2e-toy.mjs` — updated to call `wf_knowledge_put` instead of raw
  `context.md` writes; full 8-stage simulated run passes end to end
  (planning → research → task-breakdown → architecture → implementation →
  review → testing → documentation, all `APPROVED`).

## Deviations from plan

- **P1-2 (mechanical `read` interception)** is implemented, but via the
  `tool_result` hook rather than `tool_call` (which is block-only). It is
  **opt-in** through config `interceptReads` (default off) because it changes
  `read` semantics, and passing `offset`/`limit` is a per-call escape hatch to
  raw source. This is a behavioural narrowing from the plan's "always on"
  framing, chosen so an engineer reading a file to edit it can't be silently
  handed a stale-safe-but-lossy fragment. Documented in `index.ts`'s header and
  in `README.md`.

## Verification performed

- `node --experimental-strip-types --check index.ts` — clean syntax.
- `tsc --noEmit` errors confirmed pre-existing (missing `@types/node`/
  workspace deps), not a regression — same error set on `git stash` baseline.
- All four test files run and pass: `spike-test.mjs`, `concurrency-test.mjs`,
  `knowledge-test.mjs`, `e2e-toy.mjs`.
