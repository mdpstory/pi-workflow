# pi-workflow Agents

Multi-role AI workflow pipeline with hard-enforced permissions and stage gating.

## Quick Start

```bash
# Install
pi install git:github.com/mdpstory/pi-workflow

# Run as Director
PI_WORKFLOW_ROLE=director pi

# Or let Director dispatch subagents automatically
pi -p "implement feature X"
```

## Roles

| Role | Purpose | Writes To |
|------|---------|-----------|
| **Director** | Orchestrates stages, resolves conflicts | `progress.md`, `decisions.md` |
| **Planner** | Requirements, milestones, task breakdown | `plan.md`, `tasks.md`, `clarifications.md` |
| **Scout** | Codebase research, risks, dependencies | `research.md`, `clarifications.md` |
| **Architect** | System design, APIs, data flow | `architecture.md`, `decisions.md` |
| **Engineer** | Implementation per architecture spec | Source code files, `clarifications.md` |
| **Reviewer** | Code review, quality analysis | `review.md`, `clarifications.md` |
| **QA** | Test verification, acceptance criteria | `test-report.md`, `clarifications.md`, `tests/`, `*.test.*`, `*.spec.*` |
| **Documenter** | Changelogs, user docs | `changelog.md`, `README.md`, `docs/`, `clarifications.md` |

## Agent Definitions

Each agent has a detailed definition in `agents/`:

- `agents/director.md`
- `agents/planner.md`
- `agents/scout.md`
- `agents/architect.md`
- `agents/engineer.md`
- `agents/reviewer.md`
- `agents/qa.md`
- `agents/documenter.md`
- `agents/worker.md`

## Skills

Role-specific instructions in `skills/`:

- `skills/wf-director/SKILL.md`
- `skills/wf-planner/SKILL.md`
- `skills/wf-scout/SKILL.md`
- `skills/wf-architect/SKILL.md`
- `skills/wf-engineer/SKILL.md`
- `skills/wf-reviewer/SKILL.md`
- `skills/wf-qa/SKILL.md`
- `skills/wf-documenter/SKILL.md`

## Workflow Stages

```
planning → research → task-breakdown → architecture → implementation → review → testing → documentation
```

### Shared Artifacts

`architecture.md` lives in `.workflow/shared/artifacts/` — one copy for the whole repo across all parallel workflow ids, because architecture is a codebase property, not a task property. All other artifacts live per-workflow in `.workflow/<id>/artifacts/`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design and data flow
- [Configuration](docs/CONFIGURATION.md) - Config options and env vars
- [Knowledge Store](docs/KNOWLEDGE-STORE.md) - Shared context between agents
- [Message Bus](docs/MESSAGE-BUS.md) - Inter-agent communication
- [Concurrency](docs/CONCURRENCY.md) - Parallel execution safety
- [Plan: Knowledge Sharing](docs/plan-knowledge-sharing.md) - Knowledge store design

## Tools Provided

| Tool | Purpose |
|------|---------|
| `wf_init` | Initialize workflow state |
| `wf_stage_start` | Begin a stage |
| `wf_stage_complete` | Mark stage done |
| `wf_status` | Current workflow state |
| `wf_new` | Start parallel workflow |
| `wf_list` | Enumerate workflows |
| `wf_claim` | Claim director role |
| `wf_clr_open` | File clarification request |
| `wf_clr_resolve` | Resolve clarification |
| `wf_retry_bump` | Record failed attempt |
| `wf_retry_rule` | Director ruling on retry |
| `wf_write_artifact` | Write stage output |
| `wf_knowledge_put` | Store analysis fragment |
| `wf_knowledge_get` | Retrieve analysis |
| `wf_msg_post` | Send message to role |
| `wf_msg_poll` | Poll messages |
| `wf_bus_digest` | Full bus transcript |
| `wf_approve` | Human approval gate |
| `wf_continue` | Approve/reject stage after pre-approval gate |
| `wf_artifact_summary` | Token-economic polling |
| `wf_intent` | Director's persistent first-person memory/log (survives session kill) |

## Prompts

Pre-built prompt templates in `prompts/`:

- `prompts/implement.md` - Implementation workflow
- `prompts/scout-and-plan.md` - Research + planning
- `prompts/implement-and-review.md` - Implementation + review

## Tests

Test files in `tests/`:

- `tests/access.test.mjs` - Path allowlist tests
- `tests/architecture.test.mjs` - Architecture stage tests
- `tests/state.test.mjs` - Workflow state tests
- `tests/concurrency-test.mjs` - Parallel execution tests
- `tests/knowledge-test.mjs` - Knowledge store tests
- `tests/e2e-toy.mjs` - End-to-end integration
- `tests/spike-test.mjs` - Stress testing
- `tests/preapproval-test.mjs` - Approval gate tests
- `tests/note.md` - Test notes

## See Also

- [README.md](README.md) - Full documentation
- [plan.md](plan.md) - Implementation plan
- [docs/archive/](docs/archive/) - Historical planning docs
