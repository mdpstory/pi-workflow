# NOTE: subagent env passthrough (blocker for pi-workflow) — RESOLVED

Resolved by the pi-subagent merge (`f1a3adb`): `subagent/run.ts` implements
`buildChildEnv` / `RESERVED_ENV_KEYS` and threads `env` into the spawn call
(`subagent/run.ts:328`). The `env` param exists on `single`/`parallel`/`chain`
modes. Director dispatch can now use
`subagent({ agent: "engineer", env: { PI_WORKFLOW_ROLE: "engineer", PI_WORKFLOW_ID }, ... })`
as described below, no `PI_WORKFLOW_ROLE=` text-prefix workaround needed.

Kept below for historical context (original problem statement + design).

## Problem

`pi-workflow` identifies roles via `PI_WORKFLOW_ROLE` / `PI_WORKFLOW_ID` env vars.
The `subagent` extension spawns children with **no `env` option**, so the child
inherits the director's env verbatim. Putting `PI_WORKFLOW_ROLE=engineer` in the
task *text* does nothing to `process.env` in the child.

Result: every subagent runs with the director's env → `role()` resolves wrong →
role allowlist, CLR write-gate, tool ceiling, and `wf_context_append` are all
either inert or actively deny the correct role.

## Location

`@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts:335`

```ts
const proc = spawn(invocation.command, invocation.args, {
    cwd: cwd ?? defaultCwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
});
```

Also relevant: installed copy under
`~/.pi/agent/npm/node_modules/...` or wherever `subagent` is actually loaded
from — patch the *loaded* one, not just the example.

## Fix

Add an `env` field to the tool params and to the spawn call.

1. Task/chain item schema gains:
   ```ts
   env: Type.Optional(Type.Record(Type.String(), Type.String(), {
     description: "Extra environment variables for the spawned agent process"
   }))
   ```
2. Spawn:
   ```ts
   const proc = spawn(invocation.command, invocation.args, {
       cwd: cwd ?? defaultCwd,
       shell: false,
       stdio: ["ignore", "pipe", "pipe"],
       env: { ...process.env, ...(env ?? {}) },
   });
   ```
3. Thread `env` through `single` / `parallel` / `chain` modes identically.

## Consumer change (pi-workflow side, after the above lands)

`wf-director` SKILL dispatch pattern becomes:

```ts
subagent({
  agent: "engineer",
  env: { PI_WORKFLOW_ROLE: "engineer", PI_WORKFLOW_ID: wfId },
  task: "..."
})
```

and the `PI_WORKFLOW_ROLE=...` text prefix convention is deleted.

## Verification

Child asserts `process.env.PI_WORKFLOW_ROLE === "engineer"` on first `wf_*` call.
Once P0-3 (fail-loud on unassigned role) is in, a broken passthrough is a hard
error instead of a silent mis-permission.

## Fallback if upstream patch is not possible

`.workflow/<id>/claims/` tickets: director writes `{role, taskId}` before spawn,
child claims one atomically via `open(..., "wx")` on first `wf_*` call,
first-claim-wins. Deterministic for sequential dispatch, **racy for parallel
engineers** (two engineers could swap task ids). Do not use unless the env patch
is truly blocked.
