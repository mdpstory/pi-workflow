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
 * Bus (P2): .workflow/<id>/bus/<role>.jsonl, see wf_msg_post/poll/wf_msg_wait/wf_bus_digest.
 * Discussion (Fix A): .workflow/<id>/discussion.md — durable Director<->User transcript written
 *            by wf_discuss. The Director is the only role that talks to the user and must
 *            actually discuss; wf_stage_start("implementation") is denied below 2 entries and
 *            the trivial-task skip requires a "trivial-scope" entry (config:
 *            requireDiscussionBeforeImpl, default true).
 * Dispatch registry (Fix F): .workflow/<id>/inflight/*.json via wf_dispatch_note — a resumed
 *            director sees what the dead session already spawned instead of double-dispatching.
 * Status cursor (Fix E): .workflow/<id>/last-status.json — drives the "unread bus messages"
 *            counter (rejection briefs surface instead of rotting on the bus).
 *
 * Human gates: with a UI the director must pass an explicit confirm(); headless it must pass
 *            note=<the user's exact words> (>= 8 chars), quoted into decisions.md — a headless
 *            director can no longer approve its own gate. The tool_result dialog interception is
 *            advisory by default (config autoResolveGateInUi=false) so exactly one path resolves
 *            a gate.
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
import { Type } from "@earendil-works/pi-ai";
import installSubagentTool from "./subagent/tool.ts";
import { registerHooks } from "./hooks.ts";
import { registerBusTools } from "./tools/bus.ts";
import { registerClrTools } from "./tools/clr.ts";
import { registerKnowledgeTools } from "./tools/knowledge.ts";
import { registerLifecycleTools } from "./tools/lifecycle.ts";
import { registerStageTools } from "./tools/stages.ts";
import { registerStatusTools } from "./tools/status.ts";
import { showDashboard } from "./lib/config.ts";
import { collectDashboard, invalidateDashboardCache, renderDashboard, renderCompactDashboard, renderOverlayPanel, type DashboardTheme } from "./lib/dashboard.ts";
import { truncLine } from "./lib/trunc.ts";

// ---- dashboard toggle - in-memory, survives within session ----
type DashMode = "hidden" | "compact" | "full";
let _dashMode: DashMode = showDashboard() ? "compact" : "hidden";
function dashMode(): DashMode { return _dashMode; }
function setDashMode(v: DashMode) { _dashMode = v; }

export default function (pi: ExtensionAPI) {
	installSubagentTool(pi);
	registerHooks(pi);
	registerLifecycleTools(pi);
	registerStageTools(pi);
	registerClrTools(pi);
	registerStatusTools(pi);
	registerKnowledgeTools(pi);
	registerBusTools(pi);

	// ---- wf_dashboard tool: toggle/expand/overlay the workflow dashboard ----
	pi.registerTool({
		name: "wf_dashboard",
		label: "wf_dashboard",
		description: "Control the workflow dashboard widget. Toggle visibility, expand/collapse between compact 1-line and full detail, or open a floating overlay panel. Shows role, stage pipeline, artifacts, in-flight subagents, and git changes.",
		parameters: Type.Object({
			toggle: Type.Optional(Type.Boolean({ description: "true = show widget, false = hide entirely" })),
			expand: Type.Optional(Type.Boolean({ description: "true = expand to full 5-line detail, false = collapse to 1-line compact" })),
			overlay: Type.Optional(Type.Boolean({ description: "true = open floating overlay panel (dismiss with Esc)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const d = collectDashboard();

			// Handle overlay: open a floating panel that blocks until dismissed
			if (params.overlay === true) {
				if (!ctx?.ui) {
					// Headless: fall back to returning text summary
					return {
						content: [{ type: "text", text: `dashboard overlay not available (no UI). role=${d.role} stage=${d.currentStage ?? "—"} inflight=${d.inflightCount} arts=${d.artifacts.filter(a=>a.written&&!a.stub).length} wf=${d.workflowId.slice(0,8)}` }],
						details: { ...d },
					};
				}
				await ctx.ui.custom<undefined>((_tui, theme, _kb, done) => {
					const panelW = Math.min(52, process.stdout.columns - 2);
					return {
						render: (_w: number) => renderOverlayPanel(d, panelW, theme as DashboardTheme),
						handleInput: (data: string) => {
							// Escape closes the overlay
							if (data === "\x1b") done(undefined);
						},
						invalidate: () => { invalidateDashboardCache(); },
					};
				}, { overlay: true, overlayOptions: { anchor: "right-center", width: 52, offsetX: -1 } });
				return {
					content: [{ type: "text", text: `dashboard overlay dismissed. role=${d.role} stage=${d.currentStage ?? "—"} inflight=${d.inflightCount} arts=${d.artifacts.filter(a=>a.written&&!a.stub).length}` }],
					details: { ...d },
				};
			}

			// Handle toggle (show/hide)
			if (params.toggle !== undefined) {
				setDashMode(params.toggle ? "compact" : "hidden");
				return {
					content: [{ type: "text", text: params.toggle ? "dashboard ON (compact 1-line)" : "dashboard OFF — widget hidden" }],
					details: { mode: dashMode() },
				};
			}

			// Handle expand/collapse
			if (params.expand !== undefined) {
				setDashMode(params.expand ? "full" : "compact");
				return {
					content: [{ type: "text", text: params.expand ? "dashboard expanded to full detail" : "dashboard collapsed to compact 1-line" }],
					details: { mode: dashMode() },
				};
			}

			// Query mode: return current state
			return {
				content: [{ type: "text", text: `dashboard mode=${dashMode()}. role=${d.role} stage=${d.currentStage ?? "—"} inflight=${d.inflightCount} arts=${d.artifacts.filter(a=>a.written&&!a.stub).length} wf=${d.workflowId.slice(0,8)}` }],
				details: { mode: dashMode(), ...d },
			};
		},
	});

	// ---- dashboard widget registration ----
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setDashMode(showDashboard() ? "compact" : "hidden"); // reset from config on each session start

		ctx.ui.setWidget("pi-workflow-dashboard", (_tui, theme) => {
			return {
				render: (_width: number) => {
					const mode = dashMode();
					if (mode === "hidden") return [];
					try {
						const d = collectDashboard();
						if (!d.active) {
							if (mode === "compact") return [];
							return [truncLine(theme.fg("dim", "pi-workflow: idle (set PI_WORKFLOW_ROLE or load wf-director skill)"), _width)];
						}
						if (mode === "compact") return renderCompactDashboard(d, _width, theme as DashboardTheme);
						return renderDashboard(d, _width, theme as DashboardTheme);
					} catch (e) {
						return [truncLine(theme.fg("error", `pi-workflow dashboard error: ${(e as Error).message}`), _width)];
					}
				},
				invalidate: () => {
					invalidateDashboardCache();
				},
			};
		});
	});
}
