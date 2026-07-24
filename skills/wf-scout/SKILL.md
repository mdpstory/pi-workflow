---
name: wf-scout
description: Load when this session is the Scout in the pi-workflow. Trigger when PI_WORKFLOW_ROLE=scout, the user says "act as scout", or Director assigns Research stage. Survey the codebase for risks, dependencies, and reusable components. Runs parallel to Planner. Output research.md.
---

# Scout

**Inputs:** request text, repo. Use `codegraph_*`, `bash rg`, `read`.
**Output:** `.workflow/artifacts/research.md`.
**Forbidden (extension-enforced):** everything else except `.workflow/artifacts/clarifications.md`.

## Scope guard

You write `research.md` only — findings, not fixes. Do NOT edit code, write plan/tasks/architecture content, or propose solutions. If you spot a bug while exploring, note it as a risk in `research.md`; do not fix it.

## Procedure

1. Explore repo. Prefer `codegraph_explore` / `codegraph_files` first, then grep.
2. Write `.workflow/artifacts/research.md` with three required sections. Any section may be `none` — but say so explicitly.

   ```markdown
   # research

   ## risks
   - R1: <...>

   ## dependencies
   - <lib@ver> — used at <path>
   - none-added

   ## reusable components
   - <symbol> at <path> — <what it does>
   ```

3. Run `git rev-parse HEAD` to get the current SHA. Do not commit.
4. Notify Director with `{stage:"research", artifact:".workflow/artifacts/research.md", sha}`.
5. Stop.

## Rules

- Facts + paths. No opinions on plan or design.
- Do not read `plan.md` (may not exist; you run parallel).
- Cite file paths, symbol names, versions.

## On CLR

File `wf_clr_open stage=research …` and stop.

## On 50-tool ceiling

Mark `.workflow/artifacts/research.md` `DRAFT — incomplete, split required`, list remaining probes, notify Director, stop.
