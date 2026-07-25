// ---- extension hooks: tool_call (ceiling + role/CLR write gate), tool_result (P1-2 read interception) ----
import { isReadToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wfNamespaceRel, isPathAllowedForRole } from "./lib/access.ts";
import { bumpToolCalls, currentToolCalls, resetToolCalls, TOOL_CAP } from "./lib/ceiling.ts";
import { loadConfig } from "./lib/config.ts";
import { relFromRepo } from "./lib/paths.ts";
import { role, workflowActive } from "./lib/identity.ts";
import { freshFragments } from "./lib/knowledge.ts";
import { clrBlocksStage, loadClr, loadState } from "./lib/state.ts";

export function registerHooks(pi: ExtensionAPI) {
	// Reset tool counter on session start / switch / reload
	pi.on("session_start", async (_event, _ctx) => {
		resetToolCalls();
	});

	// --- tool_call hook: 50-call ceiling + role + CLR gate ---
	// The 50-call ceiling and the role/CLR gate only activate once a workflow is actually
	// in play (workflowActive()) — a bare "unassigned" session (extension installed but no
	// role claimed / env set) is completely untouched. See role()/workflowActive().
	pi.on("tool_call", async (event, _ctx) => {
		// Ceiling only applies to a session with an active role.
		if (workflowActive()) bumpToolCalls();
		const toolCalls = currentToolCalls();

		// (C3) Hard-stop (cap+5) is checked FIRST and independently of the soft ceiling, and
		// applies to every tool except the two escalation channels. The old nesting made the
		// hard-stop reachable only for tools that were also in CEILING_EXEMPT (write/edit/
		// wf_clr_open/intercom), and then re-exempted wf_clr_open/intercom from it — so it
		// could only ever fire for write/edit, the opposite of "stop everything but let the
		// agent escalate."
		const HARD_STOP_EXEMPT = ["wf_clr_open", "wf_msg_post"];
		const CEILING_EXEMPT = ["write", "edit", "wf_clr_open", "wf_msg_post", "intercom"];
		if (workflowActive() && toolCalls > TOOL_CAP + 5) {
			if (!HARD_STOP_EXEMPT.includes(event.toolName)) {
				return { block: true, reason: `pi-workflow: hard stop at ${toolCalls} tool calls. Director must reassign.` };
			}
		} else if (workflowActive() && toolCalls > TOOL_CAP) {
			if (!CEILING_EXEMPT.includes(event.toolName)) {
				return {
					block: true,
					reason: `pi-workflow: session hit ${TOOL_CAP}-tool ceiling (call ${toolCalls}). Mark your artifact \`DRAFT — incomplete, split required\`, propose sub-tasks, notify Director via wf_clr_open or wf_msg_post, then stop.`,
				};
			}
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		// No role active — untouched casual session. See workflowActive().
		if (!workflowActive()) return undefined;

		const p = (event.input as { path?: string }).path;
		if (!p) return undefined;
		const rel = relFromRepo(p);

		// Skip files outside repo root — not our business.
		if (rel.startsWith("..")) return undefined;

		const r = role();

		// 1. Role allowlist — hard-enforced for every role now, director included (P0-2).
		const allow = isPathAllowedForRole(r, rel);
		if (!allow.ok) {
			return { block: true, reason: `pi-workflow: ${allow.reason}` };
		}

		// 2. CLR gate — exempt .workflow/<id>/ state files and clarifications.md; artifacts still gated.
		const ns = wfNamespaceRel(rel);
		const isWfState = ns.inside && ns.kind === "own" && !ns.inner.startsWith("artifacts/");
		const isClarifications = ns.inside && ns.kind === "own" && ns.inner === "artifacts/clarifications.md";
		if (!isWfState && !isClarifications) {
			const state = loadState();
			const clr = loadClr();
			const gate = clrBlocksStage(clr, state.current);
			if (gate.blocked) {
				return {
					block: true,
					reason: `pi-workflow: OPEN CLR(s) block writes: ${gate.ids.join(", ")}. Resolve via wf_clr_resolve before editing.`,
				};
			}
		}

		return undefined;
	});

	// --- tool_result hook: P1-2 mechanical read interception (opt-in) ---
	// Unlike tool_call (block-only), tool_result CAN substitute a tool's content. When
	// config.interceptReads is on and a role is active, a full-file `read` of a source that
	// already has FRESH knowledge fragments (mtime+size match) returns the fragment(s)
	// instead of the raw body — the token win the plan wanted, enforced mechanically.
	// Guardrails (why this is safe + opt-in, not default):
	//   - Only full reads are intercepted. Passing offset OR limit is the escape hatch that
	//     always yields raw source (an engineer about to edit a file reads a slice / uses
	//     offset:1 to force the real bytes).
	//   - Never intercepts .workflow/ artifacts or files without fresh fragments.
	pi.on("tool_result", async (event, _ctx) => {
		if (!workflowActive()) return undefined;
		if (!loadConfig().interceptReads) return undefined;
		if (!isReadToolResult(event) || event.isError) return undefined;
		const input = event.input as { path?: string; offset?: number; limit?: number };
		if (!input.path) return undefined;
		if (input.offset != null || input.limit != null) return undefined; // escape hatch: raw source
		const rel = relFromRepo(input.path);
		if (rel.startsWith("..") || rel.startsWith(".workflow/")) return undefined;
		const { sections } = freshFragments(rel);
		if (!sections.length) return undefined;
		const header = `cached analysis (mtime+size still match) — re-run read with an offset to force raw source.\n\n`;
		return { content: [{ type: "text", text: header + sections.join("\n\n") }] };
	});
}
