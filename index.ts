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
import { Key, matchesKey } from "@earendil-works/pi-tui";
import installSubagentTool from "./subagent/tool.ts";
import { registerHooks } from "./hooks.ts";
import { registerBusTools } from "./tools/bus.ts";
import { registerClrTools } from "./tools/clr.ts";
import { registerKnowledgeTools } from "./tools/knowledge.ts";
import { registerLifecycleTools } from "./tools/lifecycle.ts";
import { registerStageTools } from "./tools/stages.ts";
import { registerStatusTools } from "./tools/status.ts";
import { collectDashboard, invalidateDashboardCache, renderOverlayPanel, type DashboardTheme } from "./lib/dashboard.ts";

// ---- dashboard overlay guard (prevent double-open) ----
let _overlayOpen = false;
let _overlayDone: ((v?: undefined) => void) | null = null;

export default function (pi: ExtensionAPI) {
	installSubagentTool(pi);
	registerHooks(pi);
	registerLifecycleTools(pi);
	registerStageTools(pi);
	registerClrTools(pi);
	registerStatusTools(pi);
	registerKnowledgeTools(pi);
	registerBusTools(pi);

	// ---- wf_dashboard tool: query state or open floating overlay ----
	pi.registerTool({
		name: "wf_dashboard",
		label: "wf_dashboard",
		description: "Query workflow dashboard state, or open a floating overlay panel (dismiss with Esc). Shows role, stage pipeline, artifacts, in-flight subagents, and git changes.",
		parameters: Type.Object({
			overlay: Type.Optional(Type.Boolean({ description: "true = open floating overlay panel (dismiss with Esc)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const d = collectDashboard();

			// Handle overlay: open floating panel, blocks until dismissed
			if (params.overlay === true) {
				if (_overlayOpen) {
					return { content: [{ type: "text", text: "dashboard overlay already open" }], details: { ...d } };
				}
				if (!ctx?.ui) {
					return {
						content: [{ type: "text", text: `dashboard (headless). role=${d.role} stage=${d.currentStage ?? "—"} inflight=${d.inflightCount} arts=${d.artifacts.filter(a=>a.written&&!a.stub).length} wf=${d.workflowId.slice(0,8)}` }],
						details: { ...d },
					};
				}
				_overlayOpen = true;
				try {
					await ctx.ui.custom<undefined>((_tui, theme, _kb, done) => {
						_overlayDone = done;
						const panelW = Math.min(52, process.stdout.columns - 2);
						return {
							render: (_w: number) => renderOverlayPanel(d, panelW, theme as DashboardTheme),
							handleInput: (data: string) => {
								if (matchesKey(data, Key.escape)) done(undefined);
							},
							invalidate: () => { invalidateDashboardCache(); },
						};
					}, { overlay: true, overlayOptions: { anchor: "right-center", width: 52, offsetX: -1 } });
				} finally {
					_overlayOpen = false;
					_overlayDone = null;
				}
				return {
					content: [{ type: "text", text: `dashboard closed. role=${d.role} stage=${d.currentStage ?? "—"} inflight=${d.inflightCount} arts=${d.artifacts.filter(a=>a.written&&!a.stub).length}` }],
					details: { ...d },
				};
			}

			// Query mode: return current state
			return {
				content: [{ type: "text", text: `role=${d.role} stage=${d.currentStage ?? "—"} inflight=${d.inflightCount} arts=${d.artifacts.filter(a=>a.written&&!a.stub).length} wf=${d.workflowId.slice(0,8)}` }],
				details: { ...d },
			};
		},
	});

	// ---- helper: toggle the dashboard overlay (shared by command + shortcut) ----
	async function toggleDashOverlay(ctx: any) {
		// If overlay is open, dismiss it
		if (_overlayOpen && _overlayDone) {
			_overlayDone(undefined);
			return;
		}
		if (_overlayOpen) return; // already open but no done ref (shouldn't happen)
		if (!ctx?.ui) return;
		const d = collectDashboard();
		_overlayOpen = true;
		try {
			await ctx.ui.custom<undefined>((_tui, theme, _kb, done) => {
				_overlayDone = done;
				const panelW = Math.min(52, process.stdout.columns - 2);
				return {
					render: (_w: number) => renderOverlayPanel(d, panelW, theme as DashboardTheme),
					handleInput: (data: string) => {
						if (matchesKey(data, Key.escape)) done(undefined);
					},
					invalidate: () => { invalidateDashboardCache(); },
				};
			}, { overlay: true, overlayOptions: { anchor: "right-center", width: 52, offsetX: -1 } });
		} finally {
			_overlayOpen = false;
			_overlayDone = null;
		}
	}

	// ---- user commands ----

	pi.registerCommand("wf-dash", {
		description: "Toggle workflow dashboard overlay",
		handler: async (_args, ctx) => { await toggleDashOverlay(ctx); },
	});

	pi.registerCommand("wf-init", {
		description: "Initialize workflow (always fresh, never blocks)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy", "warning"); return; }
			pi.sendUserMessage("call wf_init");
		},
	});

	pi.registerCommand("wf-new", {
		description: "Mint a new workflow id",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy", "warning"); return; }
			const label = args.trim() ? ` with label "${args.trim()}"` : "";
			pi.sendUserMessage(`call wf_new${label}`);
		},
	});

	pi.registerCommand("wf-resume", {
		description: "Resume existing workflow",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy", "warning"); return; }
			pi.sendUserMessage("call wf_init with resume: true");
		},
	});

	pi.registerCommand("wf-list", {
		description: "List all workflows",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy", "warning"); return; }
			pi.sendUserMessage("call wf_list");
		},
	});

	// ---- keyboard shortcut: Ctrl+Alt+D toggles dashboard overlay ----
	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle workflow dashboard overlay",
		handler: async (ctx) => { await toggleDashOverlay(ctx); },
	});
}
