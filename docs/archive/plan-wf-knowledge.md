# Plan: `wf_knowledge_put` / `wf_knowledge_get`

## Problem

Parallel subagents (scout, architect, multiple engineers) don't share memory.
Each spawns fresh — re-reads and re-reasons about the same files other agents
already analyzed. Raw disk reads are cheap; the wasted cost is duplicate
**reasoning**. No existing mechanism persists that reasoning across sibling
sessions. `wf_write_artifact` covers stage-level handoffs (research.md →
plan.md → ...) but not file-level insight sharing within/across stages.

## Design Summary

Two new tools, same file (`index.ts`), same idioms already used by
`wf_init`/`wf_stage_start`/etc:

- `pi.registerTool` + `Type.Object` params
- atomic writes via `tmp-${pid}-${Date.now()} → rename` (matches `writeJson`)
- shared vs per-workflow dir split (matches `SHARED_ARTIFACTS` /
  `sharedArtifactsDir()` reasoning already applied to `architecture.md`)

### Storage model: append-only fragments (no locking)

```
.workflow/shared/knowledge/<sanitized-file-path>/<pid>-<ts>-<role>.md   # scope: general
.workflow/<workflowId>/knowledge/<sanitized-file-path>/<pid>-<ts>-<role>.md   # scope: task
```

Each fragment is a new immutable file, never edited in place. Concurrent
writers (parallel engineers) can never collide on a filename → no per-file
lock needed, unlike `director.lock`. This is the key property that makes it
safe under the workflow's existing parallel-execution model.

Each fragment stores frontmatter:
```
---
file: src/auth.ts
role: scout
mtime: <source file mtime at write time>
size: <source file size at write time>
written: <ISO timestamp>
---
<note text>
```

### Scope parameter

```ts
wf_knowledge_put({ file, note, scope: "general" | "task" })
```

- `general` (default: **not** default — must be explicit) → shared dir,
  durable across all future workflows on this repo. Reserved for facts true
  regardless of current task ("uses JWT + refresh rotation", "no tests").
- `task` (default) → per-workflow dir, disposable, scoped to current
  `workflowId`. For anything tied to the current task's acceptance criteria
  or CLRs.

Any role may call `put`/`get` — no role gating needed (unlike `wf_init`,
which is director-only). This mirrors how any subagent already reads
artifacts freely; writing knowledge fragments carries no state-machine risk
the way stage transitions do.

### Read side: staleness filter, no locking

```ts
wf_knowledge_get({ file })
```

1. Resolves both dirs (shared + current workflowId) for the sanitized path.
2. Globs fragments, parses frontmatter.
3. stat()s the real source file once; compares mtime/size against each
   fragment's recorded values.
4. Returns two labeled sections in response text:
   - `## General (repo-wide)` — valid fragments from shared dir
   - `## Task-specific (this workflow)` — valid fragments from workflow dir
   - stale fragments omitted, with a one-line count ("2 stale fragments
     skipped — file changed since last analysis")

No merging, no single "current" note to overwrite — every fragment is
surfaced, oldest to newest, with role + timestamp so the reading agent can
weigh conflicting takes itself.

## Implementation Steps

1. **Helpers** (near `sharedArtifactsDir`/`artifactPath`, ~line 197-205):
   - `sanitizeFilePath(file: string): string` — collapse `/` and `..` into a
     safe dir-name component (reuse or mirror the existing filename-safety
     regex already used for `PI_WORKFLOW_ID` at line 157/183).
   - `knowledgeDir(file: string, scope: "general" | "task"): string`

2. **`wf_knowledge_put` tool** (new block, alongside other `wf_*` tools
   ~line 599+):
   - params: `{ file: string, note: string, scope: StringEnum(["general","task"]) }`
   - `fs.statSync(file)` for mtime/size (fail gracefully if file doesn't
     exist — note can still be written, mtime/size null → always stale on
     read, forces re-derivation)
   - write fragment via same tmp+rename pattern as `writeJson`
   - return confirmation with fragment path

3. **`wf_knowledge_get` tool**:
   - params: `{ file: string }`
   - glob both dirs, parse frontmatter (simple manual parse, no YAML dep —
     consistent with rest of file avoiding extra dependencies)
   - stat comparison, stale filtering
   - format response as described above

4. **Skill updates** (scout/architect/engineer/planner SKILL.md, in the
   `pi-workflow` skills dir): add instruction — "Before reading a source
   file, call `wf_knowledge_get`. If a valid fragment covers what you need,
   use it. After deriving non-trivial insight about a file, call
   `wf_knowledge_put` with the appropriate scope."

5. **Tests** — extend `concurrency-test.mjs` / `e2e-toy.mjs` style scripts:
   - two concurrent `wf_knowledge_put` calls on the same file never corrupt
     each other's fragment (spawn both, assert both fragment files exist
     intact)
   - `wf_knowledge_get` correctly drops a fragment after the source file is
     touched (mtime bump) between put and get
   - `general` fragment written under one `PI_WORKFLOW_ID` is visible under
     a different `PI_WORKFLOW_ID` (shared-dir behavior); `task` fragment is
     not

## Non-goals (deliberately out of scope)

- No merging/summarization of multiple fragments into one — keep it dumb,
  let the reading agent reconcile.
- No automatic promotion of `task` → `general` fragments — manual only, to
  avoid task-specific noise leaking into durable knowledge.
- No cache invalidation sweep/GC — fragments are cheap markdown files;
  `.workflow/` is already gitignored and disposable.

## Files Touched

- `index.ts` — 2 new tools + 2 helpers (~80-100 lines)
- `skills/*/SKILL.md` — one instruction line per role skill
- `concurrency-test.mjs` — new test cases
