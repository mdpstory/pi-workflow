/**
 * pi-workflow — role-enforced, stage-gated AI workflow extension.
 *
 * Role model (P0-2): three states, not two.
 *   - "unassigned": no PI_WORKFLOW_ROLE env, no in-process wf_claim() call. A casual,
 *     non-workflow session. No write gating. Only wf_status/wf_claim/wf_approve usable
 *     among wf_* tools.
 *   - "director": PI_WORKFLOW_ROLE=director env, OR wf_claim("director") called
 *     in-process (never persisted to disk, never inherited by children — loading skill
 *     wf-director calls wf_claim as step 0). Director's own write allowlist (ROLE_ALLOW.director)
 *     is now hard-enforced, same as every other role.
 *   - "<role>": PI_WORKFLOW_ROLE=<role> env — a dispatched subagent. Role allowlist +
 *     CLR gate enforced.
 * workflowActive() = role() !== "unassigned". Gating (write/edit hook, tool ceiling) only
 * activates once a role exists — including for the director itself.
 *
 * Workflow id (P0-3): PI_WORKFLOW_ID env > .workflow/.active-id marker (read+written by
 * every role, not director-only — makes "kill and restart" resume the same workflow) >
 * mint fresh + write marker. wf_new() mints an explicit new id (start workflow #2, not by
 * restarting a session). wf_list() enumerates all `.workflow/<id>/` namespaces.
 *
 * State: .workflow/<id>/state.json, .workflow/<id>/clr-index.json
 * Artifacts (per-workflow, .workflow/<id>/artifacts/): plan.md, tasks.md, research.md,
 *            decisions.md, clarifications.md, review.md, test-report.md, changelog.md
 * Shared artifact (.workflow/shared/artifacts/, one copy for the whole repo across all
 *            parallel workflow ids — architecture is a codebase property, not a task
 *            property): architecture.md
 * Knowledge (P1): per-source-file immutable fragments, .workflow/shared/knowledge/ or
 *            .workflow/<id>/knowledge/, see wf_knowledge_put/get.
 * Bus (P2): .workflow/<id>/bus/<role>.jsonl, see wf_msg_post/poll/wf_bus_digest.
 *
 * P1-2 (mechanical read interception): implemented via the `tool_result` hook (which CAN
 * substitute a tool's content — unlike `tool_call`, which is block-only). Controlled by
 * config `interceptReads`, default true (see lib/config.ts) now that freshness is
 * content-hash verified (P1-4), not mtime+size alone — a same-size edit or a git checkout
 * that preserves mtime can no longer be served as stale-but-reported-fresh. A full-file
 * `read` of a source with fresh fragments returns the fragment(s) instead of the raw body;
 * passing offset/limit is the escape hatch for raw source. Set `interceptReads: false` to
 * restore old read semantics. wf_knowledge_get remains the explicit path and works
 * regardless of the flag.
 *
 * Module layout:
 *   lib/      — pure state/path/config helpers, no tool registration.
 *   tools/    — one file per group of registerTool() calls.
 *   hooks.ts  — tool_call / tool_result / session_start hooks (ceiling + write gate).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installSubagentTool from "./subagent/tool.ts";
import { registerHooks } from "./hooks.ts";
import { registerBusTools } from "./tools/bus.ts";
import { registerClrTools } from "./tools/clr.ts";
import { registerKnowledgeTools } from "./tools/knowledge.ts";
import { registerLifecycleTools } from "./tools/lifecycle.ts";
import { registerStageTools } from "./tools/stages.ts";
import { registerStatusTools } from "./tools/status.ts";

export default function (pi: ExtensionAPI) {
	installSubagentTool(pi);
	registerHooks(pi);
	registerLifecycleTools(pi);
	registerStageTools(pi);
	registerClrTools(pi);
	registerStatusTools(pi);
	registerKnowledgeTools(pi);
	registerBusTools(pi);
}
