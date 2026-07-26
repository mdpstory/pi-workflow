# pi-workflow — Remediation Plan

Findings from a full-source audit. Ordered by risk, grouped into shippable phases.
Every item lists the file, the defect, and the fix. Phases are independent enough to
land separately.

---

## Phase 0 — Silent failures (ship first) — ✅ DONE (all 4 items shipped)

Four small fixes. All are "the system lies to its operator" class: the code does
something other than what it reports, so nobody notices until a run is already wrong.

### 0.1 Reserved env keys are stripped silently — ✅ DONE

- **File:** `subagent/run.ts` (`RESERVED_ENV_KEYS`, `buildChildEnv`), `tools/stages.ts` (DELEGATE hint), `skills/wf-director/SKILL.md`
- **Defect:** `PI_WORKFLOW_ROLE` and `PI_WORKFLOW_ID` are dropped from caller-supplied
  `env`. The director skill mandates passing them, and `wf_stage_start` emits a hint
  telling the director to pass them. Both are ignored. It currently works only by
  accident — role resolves from agent frontmatter, id from the `.active-id` marker.
  Breaks the moment a task uses a `cwd` override or the marker is absent.
- **Fix:**
  1. `buildChildEnv` returns `droppedKeys: string[]` when reserved keys were supplied.
  2. `runSingleAgent` surfaces that as a visible warning in the tool result.
  3. Delete the `env:` clause from the DELEGATE hint string in `wf_stage_start`.
  4. Rewrite the "Identity via env, not task-text convention" section of the director
     skill to say identity comes from the dispatched agent's `workflowRole` frontmatter,
     and that callers pass no role at all.
- **Test:** dispatch with `env: {PI_WORKFLOW_ROLE: "director"}` → child must not be
  director, and the result must say so.

### 0.2 Director deadlocks at the hard tool ceiling — ✅ DONE

- **File:** `hooks.ts`
- **Defect:** hard stop (`> TOOL_CAP + 5`) exempts only `wf_clr_open` and `wf_msg_post`.
  `wf_stage_start` is the only caller of `resetToolCalls()`, and it is not exempt. A
  director that burns 55 calls inside one stage can never start the next one. Only a
  process restart recovers.
- **Fix:** add `wf_stage_start`, `wf_stage_complete`, `wf_status` to `HARD_STOP_EXEMPT`.
- **Test:** drive a session past 55 calls, assert `wf_stage_start` still executes and
  resets the counter.

### 0.3 Human approval gate is convention-only — ✅ DONE

- **File:** `lib/identity.ts` (`requireHumanGate`), `tools/stages.ts` (`wf_approve`, `wf_continue`)
- **Defect:** `requireHumanGate` accepts `role === "director"` so the director can relay
  a human verdict — but nothing distinguishes relaying from inventing. Every other
  permission in this codebase is code-enforced; the one that gates human oversight is a
  comment asking the model to behave.
- **Fix:** in `wf_approve`/`wf_continue`, when `ctx.hasUI` and the caller is `director`,
  require `await ctx.ui.confirm(...)` showing the stage, sha, and verdict. No UI
  available → keep current behaviour but stamp `relayed-by-director` into `decisions.md`
  so the audit trail records that no human keystroke was captured.
- **Test:** director-role `wf_approve` with the confirm stub returning `false` must not
  mark the stage done.

### 0.4 `wf_status` omits `pendingPreApproval` — ✅ DONE

- **File:** `tools/status.ts`
- **Defect:** status prints `pendingApproval` only. A director polling status during a
  pre-approval hold sees "pending approval: none", calls `wf_stage_start`, and gets a
  `PRE_APPROVAL_REQUIRED` denial with no prior signal.
- **Fix:** add a `pending pre-approval:` line mirroring the existing one.

---

## Phase 1 — Correctness holes — ✅ DONE (all 7 items shipped)

### 1.1 CLR stage is caller-chosen and only gates upstream — ✅ DONE

- **File:** `tools/clr.ts` (`wf_clr_open`), `lib/state.ts` (`clrBlocksStage`)
- **Defect:** `clrBlocksStage` matches `idx <= curIdx`, so a CLR filed against a
  *downstream* stage blocks nothing. `stage` is free-form caller input, so an agent can
  file at a later stage and keep writing — the halt is opt-in.
- **Fix:** default `stage` to `state.current`; reject a `stage` strictly later than
  `state.current` with an explanatory denial.

### 1.2 `wf_clr_open` and `wf_retry_bump` have no role check — ✅ DONE

- **File:** `tools/clr.ts`
- **Defect:** every other wf_ tool gates on `workflowActive()` or `requireDirector()`.
  These two do not, so an unassigned session can halt or escalate an active workflow.
- **Fix:** add `workflowActive()` guards, matching the knowledge and bus tools.

### 1.3 Knowledge path sanitization collides — ✅ DONE

- **File:** `lib/paths.ts` (`sanitizeFilePath`)
- **Defect:** `a/b.ts` and a literal `a__b.ts` both map to `a__b.ts`. Two distinct source
  files share one fragment directory, so analysis cross-contaminates.
- **Fix:** name the directory `<basename>-<sha1(file).slice(0,8)>`. The authoritative
  path is already the `file:` frontmatter, which `listCoverage` reads — so nothing
  depends on the directory name being reversible.
- **Migration:** old dirs stay readable; add a one-shot re-key on `wf_init`, or accept
  that pre-existing fragments age out as stale.

### 1.4 Fragment freshness is `mtime + size` — false-fresh is possible — ✅ DONE

- **File:** `lib/knowledge.ts`, `tools/knowledge.ts`
- **Defect:** a same-size edit (character swap), or a git checkout that preserves mtime,
  leaves fragments marked fresh while the source has changed. With read interception on
  by default, an engineer about to edit that file is served stale analysis *instead of*
  the real bytes.
- **Fix:** add `hash:` (sha1 of contents) to fragment frontmatter; treat a fragment as
  fresh only on hash match. Keep `mtime`/`size` as a cheap pre-filter so the hash is
  computed only when they match.

### 1.5 `interceptReads` default contradicts its own documentation — ✅ DONE

- **File:** `index.ts` docblock vs `lib/config.ts`
- **Defect:** the docblock says "Off by default because it changes read semantics"; the
  code says `?? true`.
- **Fix:** land 1.4 first, then pick one and make both agree. Recommendation: default
  `false` until hash-based freshness ships, then `true`.

### 1.6 Architect can overwrite director rulings — ✅ DONE

- **File:** `lib/constants.ts` (`ROLE_ALLOW.architect`)
- **Defect:** `decisions.md` is in the architect allowlist, but both the director skill
  and the artifact-ownership table call it director-owned.
- **Fix:** remove `decisions.md` from `ROLE_ALLOW.architect`. If architects genuinely
  need to record design rationale, give them `design-decisions.md` as a separate
  artifact rather than sharing the rulings log.

### 1.7 Lock liveness ignores hostname — ✅ DONE

- **File:** `lib/lock.ts`
- **Defect:** `isPidAlive` runs `process.kill(pid, 0)` locally against a lock possibly
  written on another machine (shared checkout / NFS). Unrelated local PID → false ALIVE.
  PID reuse produces the same false positive on one host.
- **Fix:** compare `os.hostname()`. Same host → PID check as today. Different host →
  report `UNKNOWN (foreign host)` and require an explicit override rather than silently
  reclaiming or silently blocking.

---

## Phase 2 — Flow and design — ⬜ not started

### 2.1 `task-breakdown` is a no-op gate

- **File:** `lib/constants.ts` (`ARTIFACT_FOR_STAGE`)
- **Defect:** `planning` already requires `tasks.md`, so `planning` cannot complete
  without it — and `task-breakdown`'s only required artifact therefore always exists and
  is non-stub by the time the stage runs. The gate can never fail.
- **Fix:** either drop `tasks.md` from `planning` (planning produces `plan.md`;
  task-breakdown reconciles plan + research into `tasks.md`, which is what the director
  skill already describes), or delete the stage. Prefer the former — it matches the
  documented intent.

### 2.2 Retry cap is global and blocks unrelated stages

- **File:** `tools/stages.ts` (`wf_stage_complete`, check 3)
- **Defect:** the check scans all of `state.rulings`. One stuck defect from `review`
  permanently blocks `documentation` from completing, forever, until ruled.
- **Fix:** record the stage on each retry key and only check keys belonging to the
  current stage — or only keys bumped since the current stage started.

### 2.3 No abort / reopen path

- **Defect:** once a stage is `done`, the only way back is a rejection, which requires a
  matching pending approval. A stage completed in error is unrecoverable.
- **Fix:** add `wf_stage_reopen(stage, reason)`, director-only, which resets the stage
  and every downstream stage to `todo`, and logs to `decisions.md`.

### 2.4 Rejection destroys the rejected draft

- **File:** `tools/status.ts` (`wf_write_artifact`)
- **Defect:** writes are wholesale overwrites. On rejection the stage resets and the
  re-dispatched role overwrites the artifact — deleting the very draft the correction
  note refers to.
- **Fix:** snapshot to `artifacts/.history/<artifact>-<timestamp>.md` before every
  overwrite. Cheap, and makes rejection loops auditable.

### 2.5 Pre-approval summary is copy-pasted three times

- **File:** `tools/stages.ts`
- **Defect:** the identical summary block is built in `wf_stage_start`,
  `wf_stage_complete`, and `wf_approve`. Three places to update, guaranteed to drift.
- **Fix:** extract `buildPreApprovalSummary(completedStage, nextStage, sha)`.

---

## Phase 3 — Performance and hygiene — ⬜ not started

- **Knowledge fragments are never pruned.** `freshFragments` does a full `readdirSync` +
  frontmatter parse on every intercepted `read` and every `bash cat`. Add a prune step to
  `wf_init` (drop stale fragments) and memoize per-process by `(file, mtime, size)`.
- **`listCoverage` re-scans per directory** — it calls `freshFragments` inside the loop,
  re-stat-ing and re-parsing everything. Collect metadata in one pass.
- **`resetToolCalls()` on `session_start` is a free budget reset.** An in-process `/new`
  clears the ceiling. Either persist the counter per workflow id, or accept it and
  document it explicitly.
- **`wf_artifact_summary` cannot distinguish stub from real.** The director's primary
  polling tool returns the same "(no heading/verdict lines found)" for an untouched stub
  and a badly formatted real artifact. Return an explicit `stub: true` in `details`.
- **Bash-interception denial names no escape hatch.** The message tells the agent to use
  `read`/`wf_knowledge_get` but never mentions that `offset`/`limit` forces raw source.
- **Test files at repo root** — `e2e-toy.mjs`, `spike-test.mjs`, `concurrency-test.mjs`,
  `knowledge-test.mjs`, `preapproval-test.mjs`, `note.md`. Move to `tests/`. — ✅ DONE
  (landed as a byproduct of Phase 4, see below).

Remaining Phase 3 items (fragment pruning, `listCoverage` re-scan, tool-call ceiling
persistence, `stub: true` in `wf_artifact_summary`, bash-denial escape-hatch hint) are
still ⬜ not started.

---

## Phase 4 — Test coverage — ✅ DONE

The highest-risk code in the package — `lib/access.ts` and `lib/state.ts` — has no
dedicated test. Both are pure functions, so this is cheap.

- **Access-control matrix:** `isPathAllowedForRole` across 9 roles × ~12 path shapes
  (own artifact, foreign namespace, shared artifact, state file, source, test file,
  `docs/`, `README.md`, path traversal). Table-driven, one assertion per cell. —
  `tests/access.test.mjs` (11 cases). Also pins the actual (broader-than-documented)
  behaviour that qa/documenter get blanket non-artifact source write access, not just
  test-file/docs patterns — a real narrowing is a Phase-2/3 candidate, not done here.
- **CLR gating:** `clrBlocksStage` upstream/downstream/equal-stage cases. —
  `tests/state.test.mjs` (6 cases).
- **Stub detection:** `isStubContent` against a real artifact that quotes `_empty_`. —
  `tests/state.test.mjs` (4 cases).
- **Architecture freshness:** `isArchitectureFresh`/`stampArchitecture` — fresh right
  after stamping, stale after a real tree change, fresh again after restamp, `.workflow/`
  churn excluded from the diff. — `tests/architecture.test.mjs` (3 cases, real git
  sandbox repos).
- **Stage machine (auto-skip chains, pre-approval landing on a different stage than
  requested):** already covered by existing `tests/preapproval-test.mjs` and
  `tests/e2e-toy.mjs`; not re-duplicated as unit tests.

Run via `npm test` (node:test unit files + the mock-pi-API e2e/integration scripts).

**Side fixes made while wiring this up (pre-existing breakage, not new regressions):**
- Moved the root-level `*-test.mjs`/`e2e-toy.mjs`/`note.md` into `tests/` (this is also
  Phase 3's "test files at repo root" item — done as a byproduct).
- All 5 legacy mock-pi-API scripts hardcode a local `Type` stub that predated Phase 1.7's
  `Type.Boolean(...)` usage in `tools/lifecycle.ts` (`forceReclaimForeignLock`) — every
  one crashed with `Type.Boolean is not a function` before even reaching its assertions.
  Added `Boolean` to each stub.
- All 5 scripts read `os.homedir()` (via `loadConfig()`) without isolating `HOME` to the
  sandbox, so a real `~/.pi/agent/pi-workflow.json` (this machine has one configuring
  `requirePreApproval`/`skipStages`) silently leaked into every "sandboxed" run. Set
  `process.env.HOME = sandbox` right after `mkdtempSync` in each script.
- `tests/knowledge-test.mjs` hardcoded the pre-Phase-1.3 fragment directory name
  (`src__file2.ts`); Phase 1.3 added a `-<sha1(file).slice(0,8)>` suffix. Updated to
  discover the directory instead of hardcoding it.
- `tests/e2e-toy.mjs` asserted architect may write `decisions.md` — inverted by Phase
  1.6 (director's rulings log now, architect uses `design-decisions.md`). Updated the
  assertion to match the new, correct behaviour.

---

## Suggested order

| Phase | Scope | Risk if deferred | Status |
|---|---|---|---|
| 0 | 4 small fixes | Operator is actively misled today | ✅ DONE |
| 1 | 7 correctness fixes | Silent wrong-context writes, permission bypass | ✅ DONE |
| 4 | Test matrix | Everything above is unverifiable without it | ✅ DONE |
| 2 | Flow redesign | Wasted stages, stuck workflows | ⬜ not started |
| 3 | Perf + hygiene | Slow, cluttered, but correct | 1/6 done (repo-root test files moved) |

Phase 4 was landed third deliberately: Phases 0 and 1 shipped, then the tests that prove
them were written, before touching the stage machine in Phase 2. Phase 2 (flow/design)
is next up.
