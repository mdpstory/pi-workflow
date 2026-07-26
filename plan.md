# pi-workflow — fixes & UX plan

Guiding principle (user-stated, non-negotiable):
- **Director must always be the one discussing with the user, and must have a discussion.**
  Never fire-and-forget. The Director talks; subagents only execute.
- Parallel workflows keep working.
- Any session death mid-run → new session resumes with **zero context loss**.
- Director ↔ subagent and subagent ↔ subagent can talk + share knowledge.

---

## Flaws found (verified against code)

### F1 — Director does not have to discuss with the user at all
- `requireApproval` and `requirePreApproval` default to `undefined`/empty in `lib/config.ts`. Out of the box the Director runs planning → research → task-breakdown → architecture → implementation → review → testing → documentation with **zero user checkpoints**.
- `skills/wf-director/SKILL.md` per-stage loop explicitly says:
  > "APPROVED → immediately `wf_stage_start <next>`. Do NOT ask the user 'want me to proceed?'"
  → contradicts the "always discuss" principle.
- Bootstrap logs `wf_intent` but never confirms scope back to the user before dispatching Planner. Trivial-task escape hatch (step 5) hands directly to Engineer with **no user discussion at all**.

### F2 — Headless "director relay" auto-approves without a human
- `tools/stages.ts::confirmHumanVerdict`: when `role() === "director"` and there is no UI (`hasUI` false), the function **returns `true`** and just appends `relayed-by-director` to `decisions.md`. In headless (`pi -p`) mode the Director can approve its own `requireApproval` gates with no human keystroke. That defeats the whole point of the P3 gate.
- No requirement that the `note` field carries the actual user's chat words as an audit trail.

### F3 — Two competing human-gate paths can double-fire
- `hooks.ts` `tool_result` intercepts `AWAITING_HUMAN` / `PRE_APPROVAL_REQUIRED` and **resolves the gate inline** via the TUI confirm dialog, substituting the tool result.
- The skill simultaneously instructs the Director to *present the summary to the user in chat, wait for verdict, then call `wf_approve`/`wf_continue`*.
- Race: dialog resolves first → `pendingApproval` cleared → Director's later `wf_approve` fails with "no matching pending approval". Confusing for both LLM and user.

### F4 — Bootstrap "trivial-task" skip bypasses ALL discussion
- Director unilaterally decides "typo, one-liner, doc-only" → skips planning/research/architecture and dispatches Engineer. No user says "yes, treat this as trivial".

### F5 — Resume gaps (context loss claim doesn't fully hold)
- `intent.md` recovers Director's POV, but there is **no record of user↔Director dialogue**. If Director died after presenting a plan and hearing user say "change X", that exchange lives only in the killed session's chat log — resumed session sees only `intent.md` bullet points, not the actual conversation.
- No record of which subagent is currently in-flight. Resumed Director may double-dispatch.
- Subagent internal reasoning dies with its process; only what it wrote to disk survives. Advertised as "zero context loss" — reality is "zero *artifact* loss".

### F6 — Peer subagent "coordination" is weaker than advertised
- Skill says parallel engineers coordinate via `wf_msg_post`/`wf_msg_poll`. But each engineer is a one-shot spawned process — engineer A can finish before engineer B ever posts. No mechanism to wait for peer messages; polling is opportunistic.

### F7 — `interceptReads` default footgun
- Engineer about to edit a file does `read` → gets cached fragments, not raw source. Header warns but engineer may edit blindly. Offset/limit escape exists but isn't obvious.

### F8 — Tool-ceiling exhaustion during implementation
- Ceiling resets per stage, but `implementation` is ONE stage. Director dispatching + polling many parallel engineers can hit the 50-call hard-stop mid-graph, requiring process restart.

### F9 — Doc/code inconsistency (`progress.md`)
- `AGENTS.md` and `agents/director.md` claim Director owns `progress.md`.
- `lib/constants.ts` `ROLE_ALLOW.director` only permits `decisions.md` + `clarifications.md`. `ARTIFACT_MDS` has no `progress.md`. Attempting to write it → hard-blocked.
- Docs lie about the actual permission set.

### F10 — `wf_stage_start`/`wf_stage_complete` deny path allows fire-and-forget retries
- Reason-don't-flail rule lives in skill prose only; nothing physically stops the Director from retrying a denied stage transition in a loop.

### F11 — Rejection brief only lands on `bus/` + `decisions.md`
- `lib/gates.ts::notifyRejection` posts to bus. Fine — but if the Director's context has drifted, it may never poll after rejection. No `wf_status` line surfacing "unread rejection brief".

### F12 — `wf_status` doesn't tell resumed Director what to do next
- Dumps state + intent, but no explicit "next action" line. Resumed Director has to reason from scratch each time.

---

## Fixes (grouped, ordered by leverage)

### Fix A — Introduce `wf_discuss` tool (NEW) + `discussion.md` artifact
Durable record of every Director↔User exchange. Fills F5 + operationalises F1.

- New file: `lib/paths.ts::discussionPath()` → `.workflow/<id>/discussion.md` (top-level like `intent.md`, NOT inside `artifacts/` — sidesteps the artifact allowlist).
- New tool `wf_discuss` in `tools/status.ts`:
  ```
  wf_discuss({ topic, proposal, userSaid?, decision?, replace? })
  ```
  - `topic`: short slug ("kickoff", "plan-review", "impl-scope", "arch-choice", "review-verdict", "final-signoff")
  - `proposal`: what Director is asking / presenting to the user (verbatim)
  - `userSaid`: verbatim user reply (required unless `proposal` is a fresh open question)
  - `decision`: the resolved outcome ("proceed", "revise: X", "abort", "custom: ...")
  - Appends ISO-timestamped block to `discussion.md`. Director-only for write. Anyone can read.
- `wf_status` displays the **last 3 discussion entries** alongside intent.
- Skill mandates `wf_discuss` at these checkpoints:
  1. **Kickoff** — right after user's initial request, before `wf_init`. Confirm understanding.
  2. **After planning** — present plan.md summary, get user OK.
  3. **After architecture** — present arch summary, get user OK.
  4. **Before implementation** — confirm task graph + scope.
  5. **After testing** — present test-report summary + ask about docs scope.
  6. **Final** — hand off / sign-off.

### Fix B — Soft-enforce discussion (F1)
- `wf_stage_start("implementation")` **blocks** if `discussion.md` has < 2 entries (kickoff + plan/arch confirmation). Error is human-readable: "Director must run `wf_discuss` with the user before starting implementation."
- Trivial-task skip (F4) now requires `wf_discuss({ topic: "trivial-scope", proposal: "treating as trivial: <reason>", userSaid: "<quote>" })` first, otherwise `wf_stage_complete(skip: ...)` refuses.
- Update skill: change "Do NOT ask the user" line to "Do NOT re-ask when only routine mid-stage progression is happening; **do** discuss at the checkpoint list."

### Fix C — Close the headless auto-approve hole (F2)
- `tools/stages.ts::confirmHumanVerdict`: when `role() === "director"` and no UI:
  - `verdict` **must** carry a `note` of ≥ 8 chars whose text is treated as the user's own words (quoted into `decisions.md`).
  - Without `note`, `wf_approve`/`wf_continue` return `deny("headless director-relay requires note=<user's exact chat words>")`.
- `notifyRejection` receives the note verbatim → bus body.

### Fix D — De-conflict double-gate paths (F3)
- `hooks.ts` tool_result gate interception becomes **advisory** by default. Config knob `autoResolveGateInUi` (default `false`).
- When off: hook still opens dialog but only for **display**; returns the same `AWAITING_HUMAN` text unchanged, letting the skill's `wf_approve` call remain authoritative.
- When on: current inline-resolve behaviour preserved for power users who want one-click.
- Skill loses the branching "was it the dialog or was it me" ambiguity.

### Fix E — Resume completeness (F5)
- `wf_status` gains a `next action` computed line:
  - If `pendingApproval` → "relay user verdict via wf_approve".
  - If `pendingPreApproval` → "relay via wf_continue".
  - Elif open CLR at ≤ current → "resolve CLR <id>".
  - Elif `current === null` → "wf_stage_start <next-runnable>".
  - Else → "await subagent for stage <current>".
- `wf_status` gains an `unread bus messages` count (director-inbox files with mtime > last `wf_status` call time, tracked in `.workflow/<id>/last-status.ts`).
- `wf_status` prints last 3 `discussion.md` entries.

### Fix F — In-flight subagent tracking (F5)
- On `subagent` dispatch, extension records `.workflow/<id>/inflight/<agent>-<pid>.json` with `{ agent, task, startedAt }`. On process exit, unlink it. `wf_status` surfaces "in-flight" list so resumed Director doesn't double-dispatch.
- Best-effort — if pi doesn't expose subagent lifecycle hooks, add a lightweight `wf_dispatch_note` tool the skill calls immediately before `subagent(...)`.

### Fix G — Fix `progress.md` inconsistency (F9)
- Either add `progress.md` to Director's allowlist + `ARTIFACT_MDS`, **or** strip it from `AGENTS.md` and `agents/director.md`.
- Recommendation: **strip it**. `intent.md` + `decisions.md` + new `discussion.md` cover the role. Progress derives from `wf_status` output.

### Fix H — `interceptReads` guardrail (F7)
- When a `read` is intercepted, header adds an explicit engineer note:
  > "If you are about to EDIT this file, re-run `read` with `offset: 1` to get raw source. Editing based on fragments risks producing broken diffs."
- Consider role-based skip: if `role() === "engineer"` and the file matches a task target in `tasks.md`, do NOT intercept.

### Fix I — Ceiling relief inside implementation (F8)
- Add sub-stage reset: `wf_dispatch_group_start`/`wf_dispatch_group_end` tools that reset the tool counter for a batch of parallel engineers. Only usable during `implementation`.
- OR: raise ceiling only for `implementation` stage (e.g. 100 calls).
- Pick simpler option after prototyping.

### Fix J — Peer coordination clarity (F6)
- Document honestly: "Bus messages are fire-and-forget; use for post-facto handoff, not live sync."
- Optional: add `wf_msg_wait({ from, timeoutMs })` that blocks until a message arrives OR timeout. Only usable inside a single subagent process; still no cross-process sync guarantees.

### Fix K — Hard-block loop retries (F10)
- `hooks.ts` tool_call: track last 3 tool calls per session. If identical `wf_stage_start` / `wf_stage_complete` call fired 3× in ≤ 30 s with no state change → block with "denied loop detected — read the previous response, discuss with user, then act".

---

## New tool inventory

| tool | purpose | writer | reader |
|---|---|---|---|
| `wf_discuss` | Log Director↔User discussion checkpoint | director | any |
| `wf_dispatch_note` (opt, Fix F) | Register in-flight subagent | director | any |
| `wf_msg_wait` (opt, Fix J) | Block until peer bus message | any subagent | self |

New files:
- `.workflow/<id>/discussion.md` — durable Director↔User transcript
- `.workflow/<id>/inflight/*.json` — in-flight dispatch tracking (opt)
- `.workflow/<id>/last-status.ts` — mtime cursor for unread bus count

New config keys:
- `autoResolveGateInUi` (default `false`) — Fix D
- `requireDiscussionBeforeImpl` (default `true`) — Fix B soft-enforce toggle

---

## Skill/doc updates required

- `skills/wf-director/SKILL.md`
  - Rewrite "reason, don't flail" section to include: "Always discuss at kickoff / plan / arch / pre-impl / post-test / final. Use `wf_discuss` — it is durable, survives session death."
  - Remove/soften "Do NOT ask the user 'want me to proceed?'" — replace with "Do not re-ask *within* an already-approved stage's routine progression; DO discuss at the 6 mandated checkpoints."
  - Add kickoff discussion as Bootstrap step 2.5 (between `wf_intent` and Planner dispatch).
- `agents/director.md`: drop `progress.md`. Add `wf_discuss` to tools list.
- `docs/ARCHITECTURE.md`: add "Discussion Log" section next to "Director Intent Log".
- `AGENTS.md`: fix Director writes column: `decisions.md`, `clarifications.md`, `intent.md`, `discussion.md`.
- `README.md`: highlight "Director always discusses" as a design invariant.

---

## Order of implementation

1. **G, C, F3-fix D (config-gated)** — safe cleanups, close security holes, no behaviour change unless opted-in.
2. **A** — add `wf_discuss` tool + path + status display + skill updates.
3. **B** — soft-enforce discussion before implementation.
4. **E** — richer `wf_status` for resume.
5. **F, I, J, K, H** — refinements.

Tests to add:
- `tests/discussion.test.mjs` — wf_discuss append/read/resume.
- `tests/headless-relay.test.mjs` — no-UI director-relay requires note.
- `tests/resume.test.mjs` — kill mid-run, resume, verify next-action + discussion visible.
- Update `tests/hooks-approval-test.mjs` for new `autoResolveGateInUi` default.
