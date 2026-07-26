# Message Bus

Inter-agent communication via per-role JSONL files. Replaces `intercom` for subagent coordination.

## Why Not Intercom?

| Feature | intercom | wf_msg |
|---------|----------|--------|
| Addresses | Interactive sessions by name | Roles (`engineer`, `all`) |
| Lifetime | Dies with process | Survives process death |
| Audit | No | Full transcript |
| Use case | Session-to-session | Subagent coordination |

## Storage Structure

```
.workflow/<id>/bus/
├── director.jsonl
├── planner.jsonl
├── scout.jsonl
├── architect.jsonl
├── engineer.jsonl
├── reviewer.jsonl
├── qa.jsonl
├── documenter.jsonl
└── all.jsonl              # broadcast inbox
```

## Tools

### `wf_msg_post`

Send a message to a role or broadcast.

```typescript
// Send to specific role
wf_msg_post({
  to: "engineer",
  body: "Architecture approved, begin implementation"
})

// Broadcast to all roles
wf_msg_post({
  to: "all",
  body: "CLR opened: need clarification on API format"
})
```

### `wf_msg_poll`

Poll messages for current role.

```typescript
// Get all messages
wf_msg_poll()

// Get messages since timestamp
wf_msg_poll({ since: "2024-01-15T10:30:00Z" })
```

Returns JSONL messages as objects.

### `wf_bus_digest`

Director-only: full transcript across all roles.

```typescript
wf_bus_digest()
```

Returns complete bus history, oldest first.

## Message Format

Each line in JSONL:

```json
{
  "id": "msg_12345",
  "from": "architect",
  "to": "engineer",
  "body": "API design complete, see architecture.md",
  "timestamp": "2024-01-15T10:30:00Z",
  "threadId": "optional-thread"
}
```

## Concurrency

- Single-syscall atomic appends per role file
- No locking needed
- Each role writes only to its own file

## Patterns

### Request-Response

```typescript
// Director requests
wf_msg_post({ to: "scout", body: "Research authentication patterns" })

// Scout responds (in Scout session)
wf_msg_post({ to: "director", body: "Found 3 viable approaches in research.md" })
```

### Broadcast for Coordination

```typescript
// Director announces CLR
wf_msg_post({ to: "all", body: "CLR opened: need user input on color scheme" })

// All roles can see and pause if needed
```

### Threaded Conversations

```typescript
// Start thread
wf_msg_post({
  to: "engineer",
  body: "Question about implementation",
  threadId: "thread_abc"
})

// Reply in thread
wf_msg_post({
  to: "director",
  body: "Clarifying: use UUID for IDs",
  threadId: "thread_abc"
})
```

## Example: Director-Engineer Flow

```typescript
// Director dispatches engineer
subagent({
  agent: "engineer",
  task: "Implement user authentication per architecture.md"
})

// Engineer starts, checks messages
const msgs = wf_msg_poll()

// Engineer posts progress
wf_msg_post({
  to: "director",
  body: "Started auth module, will complete in ~5min"
})

// Director polls
const status = wf_msg_poll({ since: lastCheck })
```