# Architecture

## System Overview

pi-workflow implements a role-enforced, stage-gated AI workflow pipeline. The system coordinates multiple AI agents with hard-enforced write permissions, ensuring each role can only modify its designated outputs.

## Core Components

### 1. Role System

Three states resolved on every call:

```
unassigned → director → <role>
```

- **unassigned**: No `PI_WORKFLOW_ROLE` env, no `wf_claim` call
- **director**: `PI_WORKFLOW_ROLE=director` or `wf_claim({ role: "director" })`
- **`<role>`**: Set automatically for dispatched subagents

### 2. Stage Pipeline

```
planning → research → task-breakdown → architecture → implementation → review → testing → documentation
```

Each stage has:
- Required artifacts (e.g., `plan.md` for planning)
- Role restrictions (who can write)
- Transition checks (what must exist to proceed)

### 3. Write Enforcement

Every role has a path allowlist enforced by code:

```typescript
// Example: Director can only write
const ALLOWED_PATHS = {
  director: ['decisions.md', 'clarifications.md'],
  planner: ['plan.md', 'tasks.md'],
  architect: ['architecture.md'],
  engineer: ['src/**'], // varies by project
  // ...
};
```

### 4. Knowledge Store

Shared context between agents via immutable fragments:

```
.workflow/
├── shared/
│   └── knowledge/          # scope: "general" (durable)
│       ├── src/index.ts/
│       │   ├── frag_123.json
│       │   └── frag_456.json
│       └── ...
└── <workflow-id>/
    └── knowledge/          # scope: "task" (disposable)
        └── ...
```

### 5. Message Bus

Per-role JSONL files for inter-agent communication:

```
.workflow/<id>/bus/
├── director.jsonl
├── engineer.jsonl
├── all.jsonl              # broadcast
└── ...
```

### 6. Director Intent Log (`wf_intent`)

A durable, first-person memory for the director, persisted to `.workflow/<id>/intent.md`
— separate from `decisions.md` (passive audit trail) and `bus/` (peer messaging).
Append-by-default, each entry auto-timestamped; `{ replace: true }` resets it. Reading
requires no args and no role (any session can read); writing is director-only.
`wf_status` surfaces the current log content so a NEW director session that resumes
a workflow (via the `.active-id` marker after a killed/aborted session) recovers both
the original user request and the prior director's routing POV — even if the session
died before any stage artifact existed. Purpose-built for the "reason, don't flail"
resume path documented in `skills/wf-director/SKILL.md`.

### 6b. Discussion Log (`wf_discuss`)

The design invariant: **the Director is the only role that talks to the user, and it must
actually have the conversation.** `intent.md` records the director's own POV; it does not
record what the user *said*. `.workflow/<id>/discussion.md` does — one timestamped block per
checkpoint:

```
## [2026-01-04T12:00:03.114Z] impl-scope
- proposal: T1 handler + T2 route wiring, no auth changes
- userSaid: go ahead, but keep it unauthenticated
- decision: proceed
```

- Written by `wf_discuss` (director-only); readable by any role/session with no args.
- Lives at the top of the workflow namespace (like `intent.md`), not under `artifacts/`, so
  it is a session record rather than a stage artifact and sidesteps the artifact allowlist.
- `wf_status` replays the last 3 entries — a resumed director sees the real exchange, not just
  its own bullet points.
- **Enforced**, not merely advised: `wf_stage_start("implementation")` is denied below 2
  entries, and the trivial-task skip is denied without a `trivial-scope` entry carrying
  `userSaid` (config: `requireDiscussionBeforeImpl`, default true).

### 6c. Dispatch Registry (`wf_dispatch_note`)

`.workflow/<id>/inflight/<key>.json` records `{ agent, task, stage, startedAt, pid }` for each
subagent the director is about to spawn, cleared with `done: true` when it returns. pi exposes
no subagent lifecycle hook an extension can latch onto, so this is cooperative — but it is the
difference between a resumed director seeing "engineer/T1 dispatched 3m ago" and blindly
re-dispatching the same task. Surfaced by `wf_status`.

### 7. Approval Gates (`lib/gates.ts`)

Two human-in-the-loop gates share one resolution path so the tool-call route
(`wf_approve`/`wf_continue` in `tools/stages.ts`) and the TUI confirm-dialog
interception route (`hooks.ts`) cannot drift — same architecture stamping, same
`decisions.md` audit entry, same cascade into the next pre-approval gate:

- **P3 human gate** (`requireApproval` stages) — `wf_stage_complete` returns
  `AWAITING_HUMAN` instead of advancing; unblocked by `wf_approve`.
- **P4 pre-approval gate** (`requirePreApproval` stages) — `wf_stage_complete`
  returns `PRE_APPROVAL_REQUIRED` with a summary of what's done and what's next;
  unblocked by `wf_continue`.

Who may resolve a gate:

- An `unassigned` session IS the human — it resolves directly.
- A `director` session may only *relay*. With a UI it must pass an explicit `ui.confirm()`
  showing the verdict being relayed. **Headless** (`pi -p`, no UI) it must pass
  `note = the user's exact words` (≥ 8 chars), quoted verbatim into `decisions.md`; without a
  note the relay is denied. This closes the hole where a headless director silently approved
  its own gates.
- Every dispatched subagent role is hard-blocked.

The TUI `tool_result` interception is **advisory by default** (`autoResolveGateInUi: false`):
it notifies, then lets the tool result pass through so exactly one path (the director's
`wf_approve`/`wf_continue`) resolves the gate. Setting it `true` restores inline one-click
resolution.

On reject, `lib/gates.ts` resets the stage to in-progress and pushes a correction
brief onto the message bus (to both `director` and the stage's owning role) via
`notifyRejection`, since `decisions.md` alone doesn't guarantee anyone re-reads it.

## Data Flow

```
User Request
    │
    ▼
Director (wf_stage_start)
    │
    ├──► Planner ──► plan.md, tasks.md
    │
    ├──► Scout ──► research.md
    │
    ├──► Architect ──► architecture.md
    │
    ├──► Engineer ──► source code
    │
    ├──► Reviewer ──► review.md
    │
    ├──► QA ──► test-report.md
    │
    └──► Documenter ──► changelog.md
```

## Security Model

1. **Role Isolation**: Each role has explicit write paths
2. **CLR Gate**: Clarification requests block all writes
3. **Stage Sequencing**: Can't skip without explicit escape
4. **Director Lock**: PID-liveness based, atomic create
5. **Cross-namespace Block**: Workflows can't write to each other
6. **Read Isolation**: subagents (non-director roles) cannot read another workflow
   namespace's artifacts/state — enforced in `hooks.ts` across the `read` tool, bash
   commands (broad pattern scan, not just literal path args), and `fetch_content`;
   only the director and unassigned/human sessions see across namespaces.
7. **Shared Gate Resolution**: `lib/gates.ts` is the single source of truth for both
   approval-gate routes (tool calls and TUI dialog) so neither can diverge in what it
   stamps or logs.

## File Structure

```
pi-workflow/
├── lib/                    # Core library
│   ├── access.ts          # Path allowlist enforcement + read isolation
│   ├── architecture.ts    # Architecture stage logic
│   ├── config.ts          # Configuration loading (skipStages, requireApproval, requirePreApproval)
│   ├── gates.ts           # Shared human/pre-approval gate resolution (tools + TUI hook)
│   ├── identity.ts        # Role resolution
│   ├── knowledge.ts       # Knowledge store
│   ├── lock.ts             # Director lock
│   ├── paths.ts           # Path utilities (incl. intentPath())
│   └── state.ts           # Workflow state
├── subagent/              # Subagent dispatch
│   ├── agents.ts          # Agent discovery
│   ├── run.ts             # Process spawning
│   └── tool.ts            # Tool registration
├── tools/                 # Tool implementations
│   ├── bus.ts             # Message bus
│   ├── clr.ts             # Clarification requests
│   ├── knowledge.ts       # Knowledge tools
│   ├── lifecycle.ts       # Stage lifecycle
│   ├── stages.ts          # Stage management, wf_approve/wf_continue (via lib/gates.ts)
│   └── status.ts          # wf_status, wf_intent (director memory log)
├── agents/                # Agent definitions
├── skills/                # Role skills
└── hooks.ts              # Tool interception
```