# plan — pi-workflow rework

Goal: make the workflow actually enforce what it claims, be token-economic,
never re-read the same file twice, let agents talk to each other, and put the
human in the loop at chosen stages. No shortcuts — no convention-only rules
where a code-level backstop is possible.

Blocked-on: `NOTE-subagent-env.md` (env passthrough patch, user-owned).
Everything in P0 assumes that patch lands; P1+ does not depend on it.

---

## Milestone P0 — make enforcement real (blockers)

Nothing else ships before these. Today the role model is decorative.

### P0-1 — role propagation via env
- Depends on `NOTE-subagent-env.md`.
- `wf-director` SKILL: dispatch with `env: { PI_WORKFLOW_ROLE, PI_WORKFLOW_ID }`.
- Delete the `PI_WORKFLOW_ROLE=<role>` task-text prefix convention everywhere
  (SKILLs, README, `wf_stage_start` delegation hint).
- AC: engineer subagent writing `plan.md` is hard-blocked; writing source is
  allowed; `wf_context_append` succeeds.

### P0-2 — role resolution: no implicit director
Current `role()` returns `"director"` when `PI_WORKFLOW_ROLE` is unset, so every
plain pi session and every subagent silently *is* director.

New model — three states:

| state | when | gating | wf_* tools |
|---|---|---|---|
| `unassigned` | env unset, no claim | none (casual session, untouched) | only `wf_status`, `wf_claim` |
| `director` | `wf_claim("director")` called in-process, OR env says director | director allowlist enforced | all director tools |
| `<role>` | env `PI_WORKFLOW_ROLE=<role>` (subagent) | role allowlist enforced | role-appropriate |

- `wf_claim(role)` sets an in-process variable only — never a file, never
  inherited. Loading skill `wf-director` calls `wf_claim("director")` as step 0
  (before `wf_init`). "Use skill director" is what makes you director.
- `workflowActive()` = role !== `unassigned`. Gating turns on the moment a role
  exists, including for the director — director's own write allowlist stops
  being convention-only and becomes hard-enforced (fixes the README caveat).
- Any director-only `wf_*` tool called while `unassigned` → error
  `"no role claimed — load skill wf-director or set PI_WORKFLOW_ROLE"`.
  A subagent whose env passthrough silently failed now fails loudly instead of
  impersonating the director.
- AC: fresh pi session, no skill loaded → `write` to any path is ungated,
  `wf_stage_start` errors. After `wf_claim("director")` → source writes blocked.

### P0-3 — deterministic, resumable, parallel-safe workflow id
Kill the mint-a-random-uuid-per-director behaviour (no resume, lock unreachable,
`.workflow/` litter).

Resolution order:
1. `PI_WORKFLOW_ID` env — explicit, and the *only* thing subagents rely on once
   P0-1 lands (marker becomes a fallback, not the mechanism).
2. `.workflow/.active-id` marker — read by director too, so restart resumes the
   same workflow.
3. Only if neither exists: mint, write marker.

- New tool `wf_new({label?})` — explicitly mints a fresh id, updates marker,
  returns it. This is how you start workflow #2, not by restarting a session.
- New tool `wf_list()` — enumerate `.workflow/<id>/` with current stage + lock
  liveness, so you can see and resume parallel workflows.
- **Parallel directors**: each gets its own id (from `wf_new` or explicit env);
  their subagents inherit `PI_WORKFLOW_ID` via P0-1, so the single-pointer
  marker is no longer load-bearing for convergence. Marker documents "last
  active", used only for bare resume.
- `director.lock` becomes meaningful again (ids can now collide on resume);
  keep PID-liveness self-heal.
- AC: kill director mid-workflow, restart, `wf_status` shows the same id and
  stage. Two `wf_new` workflows run concurrently with isolated artifacts and
  correctly-namespaced subagents.

---

## Milestone P1 — knowledge layer (kills double-reads, cuts tokens)

Replaces the append-only `context.md` blob. Implements
`PLAN-wf-knowledge.md`, plus the enforcement piece that plan was missing.

### P1-1 — `wf_knowledge_put` / `wf_knowledge_get`
- Per-source-file fragments, immutable, `<pid>-<ts>-<role>.md`, no locking.
- Frontmatter records source `mtime` + `size`; `get` stat()s and drops stale.
- Scopes: `general` (`.workflow/shared/knowledge/`, durable across workflows) /
  `task` (`.workflow/<id>/knowledge/`, disposable). `task` is default.
- Any role may put/get.

### P1-2 — mechanical read interception (the part that actually saves tokens)
Prose instructions ("do not re-read files listed in context.md") do not survive
a long context window. Add to the `tool_call` hook:
- On `read` of a path with a **fresh** fragment (mtime+size match), return the
  fragment(s) with a header
  `"cached analysis by <role> @ <ts> — call read again with force:true for raw source"`
  instead of the file body.
- Escape hatch respected: an explicit re-read attempt logs why, so we can tune.
- AC: scout reads `src/foo.ts`, architect's `read` of the same unchanged file
  returns the fragment and costs ~1/10 the tokens; after touching the file it
  returns real source again.

### P1-3 — retire `context.md`
- Remove `context.md` from `ARTIFACT_FOR_STAGE` (currently a required non-stub
  artifact for 7/8 stages → ceremonial appends from roles with nothing to say).
- Keep `wf_context_append` as a thin shim writing a `task`-scope fragment, or
  delete it once SKILLs are migrated. Decide at implementation time; do not keep
  two overlapping stores.
- Update every SKILL: `wf_knowledge_get` before reading, `wf_knowledge_put`
  after deriving non-trivial insight.

---

## Milestone P2 — agent bus (chatroom)

`intercom` is the wrong substrate: it targets interactive sessions, spawned
subagents have no stable discoverable name, and messages die with the process.

- `wf_msg_post({ to: "<role>|all", body, threadId? })`
- `wf_msg_poll({ since? })` — returns messages addressed to caller's role or
  `all`, plus its own for context.
- Storage: `.workflow/<id>/bus/<role>.jsonl`, single `appendFileSync` per
  message (same atomicity argument as `wf_context_append`).
- Properties gained over intercom: works subagent↔subagent and
  subagent↔director, survives process death, fully auditable after the run,
  no name discovery.
- Director gets a `wf_bus_digest()` view for the transcript.
- SKILL updates: parallel engineers coordinate shared signatures via the bus,
  not intercom. Remove intercom instructions from `wf-engineer`.
- AC: two parallel engineers exchange an interface signature and both see it;
  transcript readable after both processes exit.

---

## Milestone P3 — human-in-the-loop gate

You direct the director. Stage completion can stop and ask you.

- Config `.pi/pi-workflow.json`:
  `{ "requireApproval": ["architecture", "implementation"] }`
- `wf_stage_complete` on a gated stage → does **not** mark done; returns
  `AWAITING_HUMAN` with a summary block:
  - what was produced (artifact paths + verdict lines)
  - what the director intends to do next
  - the specific question ("is this correct?" / "good to proceed?")
- New tool `wf_approve({ stage, sha, verdict: "approve"|"reject", note? })`.
  Callable **only by an `unassigned` role** — i.e. you, in your own session, not
  by any agent. Reject writes the note to `decisions.md` and sets the stage back
  to `in-progress` with the note as the correction brief.
- Director SKILL: on `AWAITING_HUMAN`, present the summary to the user and stop.
  Do not spawn anything, do not retry.
- AC: with `requireApproval: ["architecture"]`, the run halts after architecture
  with a readable summary; `wf_approve reject` re-runs the architect with the
  note; `approve` proceeds.

---

## Milestone P4 — director token diet

Director currently reads every artifact in full **and** embeds `context.md` into
each dispatch prompt — paying for the same content ~5×.

- Stop embedding knowledge into task prompts. Subagents fetch via P1-1.
- New `wf_artifact_summary({ artifact })` — returns verdict/heading lines only
  (`## verdict:`, `## findings`, `DRAFT — incomplete`). Director reads full text
  only on `BLOCKED` or before a human-gate summary.
- SKILL: replace "read artifact in full" with "read summary; full read only on
  BLOCKED / human gate".
- AC: measured director input tokens for the toy e2e run drop materially vs.
  baseline (record both numbers in the test output).

---

## Milestone P5 — correctness cleanup

Small, independent, each with a regression test.

| id | defect | fix |
|---|---|---|
| C1 | `wf_stage_start` auto-skip tells director to call `wf_stage_complete(sha:"auto-skip")`, which fails the `^[0-9a-f]{7,40}$` check → infinite BLOCKED loop | auto-skip already marks the stage done; make the response say "do not call wf_stage_complete", and have `wf_stage_complete` return APPROVED-noop for an already-done auto-skipped stage |
| C2 | retry off-by-one: bump warns at `>=3`, stage-complete blocks at `>3` | both `>=3` |
| C3 | ceiling `cap+5` branch is nested inside the `>cap` branch after the non-exempt return → only ever blocks `write`/`edit`, the exact opposite of intent | restructure: hard-stop check first, exempting `wf_clr_open`/`wf_msg_post` only |
| C4 | `isStubContent` matches `_empty_` **anywhere** in the file → any artifact quoting that token is judged a stub | exact-match sentinel or a `.stub` sidecar marker |
| C5 | `wf_init` silently creates/appends `.gitignore`; also `includes(".workflow/")` misses an existing `.workflow` line | ask before writing, match both forms |
| C6 | stage `status` is write-only (`blocked`/`retry`/`failed` never read); resolved CLR never restores `blocked` → `in-progress` | either consult it in transitions or remove the unused states — no dead state |
| C7 | `heartbeatAt` never refreshed by subagents, liveness is PID-only | drop the field or actually heartbeat |
| C8 | README claims `PI_SESSION_ID` namespacing (unused), "hard-enforced" write gate (inert), and a concurrency section describing `context.md` races the code already fixed | rewrite README against post-P3 code |
| C9 | `wf_write_artifact` is registered by the installed copy but absent from this `index.ts` — two diverged sources of truth | reconcile; one canonical repo, reinstall from it |

---

## Sequencing

```
P0-1 ─┬─ P0-2 ─ P0-3 ──┬── P1 ── P4
      │                ├── P2
      └────────────────┴── P3
P5 — anytime, independent
```

P0 is a hard gate. P1/P2/P3 are parallelizable once P0 lands. P4 depends on P1.

## Non-goals

- No fragment merging/summarization — the reading agent reconciles.
- No auto-promotion of `task` → `general` knowledge.
- No GC of `.workflow/` — cheap markdown, gitignored. `wf_list` makes stale ids
  visible; manual cleanup.
- No replacement of `intercom` for human↔session use; only agent↔agent moves to
  the bus.
