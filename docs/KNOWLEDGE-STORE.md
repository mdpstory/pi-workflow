# Knowledge Store

Shared context between agents via immutable fragments. Replaces the old append-only `context.md`.

## Concepts

### Fragments

Immutable analysis notes about source files:

```json
{
  "file": "src/index.ts",
  "note": "Main entry point, exports all public APIs",
  "scope": "general",
  "role": "architect",
  "mtime": 1234567890,
  "size": 1024,
  "hash": "abc123..."
}
```

### Scopes

| Scope | Location | Lifetime |
|-------|----------|----------|
| `general` | `.workflow/shared/knowledge/` | Durable, survives workflow IDs |
| `task` | `.workflow/<id>/knowledge/` | Disposable, removed with workflow |

Promote durable facts to `general` scope.

## Storage Structure

```
.workflow/
├── shared/
│   └── knowledge/
│       └── src/
│           └── index.ts/
│               ├── general/
│               │   ├── frag_12345.json
│               │   └── frag_67890.json
│               └── ...
└── <workflow-id>/
    └── knowledge/
        └── src/
            └── index.ts/
                └── task/
                    └── frag_11111.json
```

## Tools

### `wf_knowledge_put`

Store an analysis fragment.

```typescript
wf_knowledge_put({
  file: "src/index.ts",
  note: "Main entry point, exports all public APIs",
  scope: "general"  // or "task"
})
```

- Fragment filename includes PID + timestamp + role
- No locking needed (immutable, unique names)
- Automatically stores file metadata (mtime, size, hash)

### `wf_knowledge_get`

Retrieve fragments for a file.

```typescript
// Get fragments for specific file
wf_knowledge_get({ file: "src/index.ts" })

// Get coverage table (all analyzed files)
wf_knowledge_get()
```

Returns:
- Up to 3 newest fresh fragments per scope
- Byte-identical duplicates dropped
- Stale fragments excluded and counted

### Freshness Check

Fragments are considered fresh if:

1. `mtime` matches file on disk
2. `size` matches file on disk
3. `hash` (SHA-1) matches file content

Cheap pre-filter: mtime + size
Actual verdict: content hash

## Read Interception

When `interceptReads: true` (default):

```typescript
// Returns knowledge fragments instead of raw content
read("src/index.ts")

// Bypass interception with offset/limit
read("src/index.ts", { offset: 0, limit: 100 })
```

### About-to-edit safety (Fix H)

Fragments are analysis, not source — an `edit` whose `oldText` came from a fragment will not
match. Two guardrails:

- Substituted content carries an explicit header: *"If you are about to EDIT this file, re-run
  read with `{ offset: 1 }` to force raw source."*
- An **engineer** reading a file that `tasks.md` names as a task target is never intercepted —
  that role is about to modify it, so it always gets raw bytes.

### Bash Bypass Blocked

These commands are blocked for files with fresh fragments:

```bash
cat src/index.ts      # ❌ Blocked
head src/index.ts     # ❌ Blocked
tail src/index.ts     # ❌ Blocked
sed -n '1,10p' src/index.ts  # ❌ Blocked
```

Use `read` or `wf_knowledge_get` instead.

`grep` and other bash reads are unaffected.

## Token Economics

- Only 3 newest fragments per scope returned
- Older fragments noted as omitted
- Duplicate content dropped
- Prevents token multiplication with N agents

## Example Workflow

```typescript
// Architect analyzes file
wf_knowledge_put({
  file: "src/api.ts",
  note: "REST endpoints for /users, /posts. Uses Express router.",
  scope: "general"
})

// Engineer reads same file
const knowledge = wf_knowledge_get({ file: "src/api.ts" })
// Returns architect's analysis instead of raw file

// Engineer gets overview of all analyzed files
const coverage = wf_knowledge_get()
// Returns table: path | scope | fragments | fresh?
```