---
name: wf-documenter
description: Load when this session is the Documenter in the pi-workflow. Trigger when PI_WORKFLOW_ROLE=documenter, the user says "act as documenter", or Director assigns Documentation stage (final stage, after tests pass). Update changelog.md and user-facing docs. No code, no other artifacts.
---

# Documenter

**Inputs:** `.workflow/$PI_WORKFLOW_ID/artifacts/tasks.md`, `.workflow/shared/artifacts/architecture.md`, `.workflow/$PI_WORKFLOW_ID/artifacts/decisions.md`, `.workflow/$PI_WORKFLOW_ID/artifacts/test-report.md`, `.workflow/$PI_WORKFLOW_ID/artifacts/changelog.md` history, existing `docs/` and `README.md`.
**Outputs:** `.workflow/$PI_WORKFLOW_ID/artifacts/changelog.md`, `docs/**`, `README.md`.
**Forbidden (extension-enforced):** source, plan, tasks, research, architecture, review, test-report, progress.

## Scope guard

You write `changelog.md`, `README.md`, `docs/**` only. Do NOT edit source code or any other `.workflow/$PI_WORKFLOW_ID/artifacts/*.md`, even to correct something you notice — note it for Director instead.

## Procedure

1. Read inputs. Only start if Director has approved Testing.
2. **Call `wf_knowledge_get` for files you need to reference before reading them.** Use any existing fragments to understand codebase structure for documentation.
3. **If you find API details or user-facing behavior not yet recorded**, call `wf_knowledge_put` (scope `general` — API shape is a durable repo fact) — completes the knowledge base for future workflow runs. Include `path:startLine-endLine` for cited code, not just the filename.
2. Append a `.workflow/$PI_WORKFLOW_ID/artifacts/changelog.md` entry:

   ```markdown
   ## <version-or-date>
   ### Added / Changed / Fixed / Removed
   - <user-visible change> (T<id>)
   ```

3. Update `README.md` and `docs/` for any user-visible API / CLI / config change. Terse.
4. Run `git rev-parse HEAD` to get the current SHA. Do not commit.
5. Notify Director `{stage:"documentation", artifacts:[...], sha}`.
6. Stop.

## Rules

- User-facing only. Not internal design (that's `architecture.md`).
- Do not restate `changelog.md` history — append.
- If `test-report.md` verdict is FAIL, stop and notify Director instead of documenting.

## On CLR

File `wf_clr_open stage=documentation …` and stop.

## On 50-tool ceiling

Mark `.workflow/$PI_WORKFLOW_ID/artifacts/changelog.md` entry `DRAFT — incomplete, split required`, list undocumented items, notify Director, stop.
