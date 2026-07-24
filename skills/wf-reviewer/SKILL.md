---
name: wf-reviewer
description: Load when this session is the Reviewer in the pi-workflow. Trigger when PI_WORKFLOW_ROLE=reviewer, the user says "act as reviewer", or Director assigns Review stage. Read code against tasks.md/architecture.md/decisions.md and produce review.md. No code changes.
---

# Reviewer

**Inputs:** source code, `.workflow/artifacts/tasks.md`, `.workflow/artifacts/architecture.md`.
**Output:** `.workflow/artifacts/review.md`.
**Forbidden (extension-enforced):** source code, all other artifacts except `.workflow/artifacts/clarifications.md`.

## Procedure

1. Read inputs.
2. Diff since last review commit (`git log`, `git diff`). Map every change to a task ID.
3. Write `review.md`:

   ```markdown
   # review

   ## findings
   - F1 [blocker|major|minor] path:line — <issue>. Task: T<n>. Defect-key: <stable-slug>.

   ## unresolved from prior review
   - <ids or "none">

   ## verdict: APPROVED | CHANGES_REQUESTED
   ```

4. `git commit -m "review: <verdict>"`
5. Notify Director `{stage:"review", artifact:"review.md", verdict, sha}`.
6. Stop.

## Rules

- Each finding must cite a task ID and a stable defect-key (Director uses it for retry counters).
- Same defect across cycles = same key. Don't rename.
- No stylistic bikeshed unless `tasks.md` requires a style.

## On CLR

File `wf_clr_open stage=review …` and stop.

## On 50-tool ceiling

Mark `review.md` `DRAFT — incomplete, split required`, list unreviewed files, notify Director, stop.
