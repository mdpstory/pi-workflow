# Concurrency

pi-workflow handles concurrent execution across multiple workflows and parallel subagents.

## Director Lock

### Mechanism

PID-liveness based with atomic exclusive-create:

```typescript
// Pseudocode
const lockFile = `.workflow/<id>/.director-lock`
const fd = open(lockFile, { flags: 'wx' })  // exclusive create
write(fd, JSON.stringify({ pid: process.pid }))
```

### Liveness Check

```typescript
// Signal 0 checks if process exists
process.kill(lockPid, 0)
```

Not a heartbeat timestamp — actual PID liveness.

### Race Prevention

- `wx` flag (exclusive create) prevents check-then-create race
- Two directors starting simultaneously: only one wins
- Loser gets clear error, retries or abandons

## Knowledge Fragments

### No Locking Needed

Each fragment is:
- Immutable (never modified after creation)
- Uniquely named (`frag_<pid>_<timestamp>_<role>.json`)
- Independent file

Multiple agents can write simultaneously without conflict.

### Retrieval Safety

- Reads only newest 3 fresh fragments per scope
- Byte-identical duplicates dropped
- Stale fragments excluded (mtime + size + hash check)

## Message Bus

### Atomic Appends

Each role file gets single-syscall atomic appends:

```typescript
// Pseudocode
const fd = open(`bus/${role}.jsonl`, { flags: 'a' })
write(fd, JSON.stringify(message) + '\n')
```

### No Locking Needed

- Each role writes only to its own file
- `all.jsonl` broadcast: each writer appends atomically
- Readers see consistent state per read

## Cross-namespace Isolation

### Write Block

Writes to another workflow's namespace are hard-blocked:

```typescript
// Workflow A cannot write to
.workflow/B/artifacts/...  // ❌ Blocked

// Even director
wf_write_artifact({
  filename: "plan.md",
  content: "...",
  workflowId: "other-workflow"  // ❌ Blocked
})
```

### Exception: Shared Artifacts

`architecture.md` lives in `.workflow/shared/` and is readable/writable by all workflow IDs (Architect role only).

## Parallel Workflows

### Independent Execution

```bash
# Session A
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=feature-x pi

# Session B (same repo, same time)
PI_WORKFLOW_ROLE=director PI_WORKFLOW_ID=notifications pi
```

- Separate state directories
- Separate locks
- No shared mutable state (except `architecture.md`)

### Coordination

Use message bus for cross-workflow awareness:

```typescript
// In workflow A
wf_msg_post({ to: "all", body: "Starting auth refactor" })

// In workflow B (polls "all")
const msgs = wf_msg_poll()
// Sees workflow A's message
```

## Parallel Subagents

### Dispatch

```typescript
subagent({
  tasks: [
    { agent: "engineer", task: "Implement module A" },
    { agent: "engineer", task: "Implement module B" },
    { agent: "engineer", task: "Implement module C" },
    { agent: "engineer", task: "Implement module D" }
  ]
})
```

- Max 8 tasks
- Max 4 concurrent
- Each gets own process, context, tools

### Identity Isolation

Each subagent inherits workflow ID but gets own:
- Process ID
- Context window
- Tool state

`PI_WORKFLOW_ROLE` set automatically from agent's `workflowRole` frontmatter.

## CLR Gate

### Write Blocking

Open CLR blocks ALL writes:

```typescript
// While CLR is open
wf_write_artifact(...)  // ❌ Blocked
wf_stage_complete(...)  // ❌ Blocked
// Only wf_clr_resolve works
```

### Resolution

```typescript
wf_clr_resolve({
  id: "clr_123",
  resolution: "Use REST API with JSON payloads"
})
```

Unblocks all writes.

## Director Lock Recovery

### Stale Lock Detection

```typescript
// Check if lock holder is alive
const lock = readLock()
const alive = process.kill(lock.pid, 0)

if (!alive) {
  // Lock is stale, can reclaim
  reclaimLock()
}
```

### Manual Recovery

```typescript
wf_init({ forceReclaimForeignLock: true })
```

Use when:
- Confirmed no other machine runs this workflow
- Lock holder crashed
- Development/testing recovery