# Plan — knowledge sharing between Director and subagents

Goal: a file read once by one agent is never re-read in full by another agent in the
same workflow. Today the machinery exists but is unreachable from subagents.

## P0-1 — Grant knowledge/comms tools to every role agent (blocking bug)

**Problem:** `agents/*.md` frontmatter `tools:` lists omit `wf_knowledge_put` /
`wf_knowledge_get`. `subagent/run.ts:316` passes that list as `--tools`, which hard-filters
the tool set. Every role SKILL.md instructs "call `wf_knowledge_get` before reading /
`wf_knowledge_put` after reading" — those calls are impossible. Net effect: zero sharing,
every subagent re-reads every file.

**Change:** append to `tools:` in
`agents/{scout,architect,engineer,reviewer,qa,documenter,planner}.md`:

```
wf_knowledge_get, wf_knowledge_put, wf_clr_open, wf_msg_post, wf_msg_poll
```

- `planner`, `reviewer`, `scout`, `documenter`: read-only roles — knowledge tools write only
  into `.workflow/`, so no source-write escalation.
- `director.md`: verify it already has both knowledge tools; add if missing.

**Acceptance:** spawn scout via `subagent`, confirm it can call `wf_knowledge_put`;
`ls .workflow/shared/knowledge/` is non-empty after a research stage.

## P0-2 — Default `interceptReads` to true

**Problem:** `lib/config.ts` / README:78 default `false`, so dedup depends on agents
remembering to call `wf_knowledge_get`. Forgetting costs a full file body.

**Change:** default `interceptReads: true` in `loadConfig()`. Escape hatch already exists
(pass `offset`/`limit` to force raw source); `.workflow/` paths already exempt.

**Acceptance:** with a fresh fragment for `X`, a plain `read X` in a role session returns the
cached-analysis text; `read X` with `offset: 1` returns raw bytes.

## P1-1 — Coverage listing (`wf_knowledge_get` with no `file`)

**Problem:** no way to ask "what is already known?". Director must guess file names one at a
time (`skills/wf-director/SKILL.md:57`); agents can't discover coverage, so they read
everything.

**Change:** make `file` optional in `wf_knowledge_get`. When omitted, walk
`.workflow/shared/knowledge/` + `.workflow/<id>/knowledge/` and return a compact table:
`path | scope | fragments | fresh?`. Reverse `sanitizeFilePath` by reading the `file:`
frontmatter field of the first fragment (do not try to un-mangle the dir name).

**Acceptance:** after scout, `wf_knowledge_get({})` lists each analyzed file once with a
fresh/stale flag; output stays under ~1KB for a 30-file survey.

## P1-2 — Cap / dedup fragments per file

**Problem:** fragments are append-only and `freshFragments` concatenates *all* fresh ones.
N agents analyzing the same file means every later retrieval pays N× tokens.

**Change:** in `lib/knowledge.ts`, after collecting fresh fragments per scope, keep at most
the newest K (K=3) per scope, ordered by `written`, and append
`_M older fragment(s) omitted_`. Optional: skip a fragment whose body is byte-identical to a
newer one.

**Acceptance:** 6 puts on one file → `wf_knowledge_get` returns 3 newest + omission note.

## P1-3 — Close the bash/codegraph bypass

**Problem:** interception only covers the `read` tool. Agents have `bash`, so
`cat`/`sed`/`grep -A200` and `codegraph_explore` return full source untouched.

**Change (cheap, advisory-first):**
- Add to every role SKILL.md "Rules": never `cat`/`sed` a source file to read it — use `read`
  (so interception applies) or `wf_knowledge_get`.
- In the `tool_call` hook, when a role is active and `interceptReads` is on, detect a bash
  command that is a bare pager on a path with fresh fragments (`^\s*(cat|head|tail|sed -n)\b`)
  and block with reason "use read/wf_knowledge_get — cached analysis exists for <path>".
  Regex-scoped and easy to bypass on purpose; that is fine, it targets the habitual case.

**Acceptance:** `bash cat src/app.ts` blocked with the hint when a fresh fragment exists;
`bash grep -n foo src/app.ts` still allowed.

## P2-1 — Task-scope carryover note (docs only)

`scope: "task"` fragments live under `.workflow/<id>/knowledge/`, so a new workflow id starts
cold; only `general` carries over. Intended, but undocumented. Add one line to README's
knowledge section and to `wf_knowledge_put`'s tool description: "engineer/QA notes stored as
`task` disappear with the workflow id — promote durable facts to `general`."

## P2-2 — Director self-discipline

Director has unintercepted `read` for files without fragments, and the classic failure is
"director reads everything, pastes into each subagent prompt" — duplication squared.

**Change (docs):** in `skills/wf-director/SKILL.md`, state that Director must call
`wf_knowledge_get({})` (P1-1) to build the file list, and inject *fragments*, never raw file
bodies, into task prompts. If a needed file has no fragment, dispatch an agent to analyze it
instead of reading it in the Director session.

## Order

P0-1 → P0-2 (unblocks everything, small) → P1-1 → P1-2 → P1-3 → P2-*.
P0-1 alone recovers most of the token win; the rest is leak-plugging.

## Test

Extend `knowledge-test.mjs`: fragment cap (P1-2), listing mode (P1-1), and an e2e assertion in
`e2e-toy.mjs` that the second subagent's transcript contains no full body of a file the first
one already analyzed.
