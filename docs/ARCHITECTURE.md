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

## File Structure

```
pi-workflow/
├── lib/                    # Core library
│   ├── access.ts          # Path allowlist enforcement
│   ├── architecture.ts    # Architecture stage logic
│   ├── config.ts          # Configuration loading
│   ├── identity.ts        # Role resolution
│   ├── knowledge.ts       # Knowledge store
│   ├── lock.ts            # Director lock
│   ├── paths.ts           # Path utilities
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
│   ├── stages.ts          # Stage management
│   └── status.ts          # Status reporting
├── agents/                # Agent definitions
├── skills/                # Role skills
└── hooks.ts              # Tool interception
```