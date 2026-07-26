// ---- extension hooks: tool_call (ceiling + role/CLR write gate), tool_result (P1-2 read interception) ----
import { isReadToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wfNamespaceRel, isPathAllowedForRole, isPathReadableByRole } from "./lib/access.ts";
import { bumpToolCalls, currentToolCalls, resetToolCalls, TOOL_CAP } from "./lib/ceiling.ts";
import { loadConfig, requirePreApprovalSet, skipStagesSet } from "./lib/config.ts";
import { relFromRepo, artifactsDir } from "./lib/paths.ts";
import { role, workflowActive } from "./lib/identity.ts";
import { freshFragments } from "./lib/knowledge.ts";
import { clrBlocksStage, loadClr, loadState, saveState } from "./lib/state.ts";
import { ARTIFACT_FOR_STAGE, nextStage as rawNextStage, ROLE_FOR_STAGE, type Stage } from "./lib/constants.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// Replicate nextGateStage: find next stage skipping configured-skip and already-done stages
function nextGateStage(state: ReturnType<typeof loadState>, from: Stage): Stage | null {
	const skip = skipStagesSet();
	let n = rawNextStage(from);
	while (n && (skip.has(n) || state.stages[n]?.status === "done")) n = rawNextStage(n);
	return n;
}

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
		// wf_stage_start/wf_stage_complete/wf_status must survive the hard stop too —
		// wf_stage_start is the only caller of resetToolCalls(), so without this a
		// director that burns past the hard ceiling inside one stage can never start
		// the next stage (or even check status) and needs a process restart (P0-2).
		const HARD_STOP_EXEMPT = ["wf_clr_open", "wf_msg_post", "wf_stage_start", "wf_stage_complete", "wf_status"];
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

		// P1-3: close the bash pager bypass around read interception. A bare cat/head/tail/
		// sed -n on a path with fresh knowledge fragments returns full source untouched by
		// the tool_result hook (which only covers `read`) — nudge back to read/wf_knowledge_get.
		// Regex-scoped and easy to bypass on purpose (e.g. `grep -A200`, piping through xargs);
		// this targets the habitual case, not a security boundary.
		if (event.toolName === "bash" && workflowActive()) {
			const cmd = (event.input as { command?: string }).command ?? "";
			const m = /^\s*(?:cat|head|tail|sed\s+-n)\b[^|&;]*?([^\s|&;]+)\s*$/.exec(cmd);
			if (m) {
				const rel = relFromRepo(m[1]);
				if (rel.startsWith(".workflow/")) {
					// Read isolation: block bash reads of foreign workflow namespaces
					const readCheck = isPathReadableByRole(role(), rel);
					if (!readCheck.ok) {
						return { block: true, reason: `pi-workflow: ${readCheck.reason}` };
					}
				} else if (!rel.startsWith("..") && loadConfig().interceptReads) {
					const { sections } = freshFragments(rel);
					if (sections.length) {
						return { block: true, reason: `pi-workflow: use read/wf_knowledge_get — cached analysis exists for ${rel}` };
					}
				}
			}
			// Broader net: any bash command that mentions a foreign workflow namespace
			// (grep/ls/awk/python/etc. bypass the cat|head|tail|sed regex above). Not a
			// full parser — scans literal ".workflow/<id>" tokens in the command string.
			for (const idMatch of cmd.matchAll(/\.workflow\/([A-Za-z0-9_-]+)/g)) {
				const rel = `.workflow/${idMatch[1]}`;
				const readCheck = isPathReadableByRole(role(), rel);
				if (!readCheck.ok) {
					return { block: true, reason: `pi-workflow: ${readCheck.reason}` };
				}
			}
		}

		// Read isolation: subagents (non-director roles) cannot read other workflow
		// namespaces. Each workflow can only see its own artifacts and .workflow/shared/.
		// Covers both `read` and `fetch_content` (local-file / file:// fetches) since both
		// return raw file content to the model.
		if ((event.toolName === "read" || event.toolName === "fetch_content") && workflowActive()) {
			const input = event.input as { path?: string; url?: string; urls?: string[] };
			const candidates = [input.path, input.url, ...(input.urls ?? [])]
				.filter((v): v is string => !!v)
				.map((v) => v.replace(/^file:\/\//, ""));
			for (const p of candidates) {
				const rel = relFromRepo(p);
				if (!rel.startsWith("..")) {
					const readCheck = isPathReadableByRole(role(), rel);
					if (!readCheck.ok) {
						return { block: true, reason: `pi-workflow: ${readCheck.reason}` };
					}
				}
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

	// --- tool_result hook: approval gate interception + P1-2 read interception ---
	// When wf_stage_complete or wf_stage_start returns PRE_APPROVAL_REQUIRED or
	// AWAITING_HUMAN, intercept the tool result and show a native confirm dialog.
	// If the human approves, resolve the gate inline so the agent sees the verdict
	// without needing to call wf_continue/wf_approve manually.
	pi.on("tool_result", async (event, ctx) => {
		if (!workflowActive()) return undefined;
		if (event.isError) return undefined;

		// Check for approval-decision tool results
		const details = (event as { details?: { decision?: string; stage?: string; nextStage?: string; sha?: string } }).details;
		if (!details?.decision) return undefined;
		if (details.decision !== "PRE_APPROVAL_REQUIRED" && details.decision !== "AWAITING_HUMAN") return undefined;

		// Need UI to show confirm dialog
		if (!ctx.hasUI || !ctx.ui?.confirm) return undefined;

		const state = loadState();
		const toolName = event.toolName;

		if (details.decision === "PRE_APPROVAL_REQUIRED" && (toolName === "wf_stage_complete" || toolName === "wf_stage_start")) {
			// P4 gate: next stage needs approval before starting
			const nextStage = details.nextStage!;
			const completedStage = details.stage!;
			const summary = state.pendingPreApproval?.summary ?? event.content.map(c => c.type === "text" ? c.text : "").join("");
			const cleaned = summary.replace(/\n## question[\s\S]*$/, "");
			const confirmed = await ctx.ui.confirm(
				"pi-workflow",
				`Approve starting "${nextStage.replace(/-/g, " ")}"?\n${cleaned}\n\nApprove to proceed?`,
			);
			if (confirmed) {
				state.pendingPreApproval = null;
				saveState(state);
				return {
					content: [{ type: "text", text: `PRE-APPROVED ${nextStage} — director may now call wf_stage_start("${nextStage}")` }],
				};
			} else {
				// Reject: reset completed stage to in-progress
				state.stages[completedStage as keyof typeof state.stages].status = "in-progress";
				state.current = completedStage;
				state.pendingPreApproval = null;
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## pre-approval rejection (UI): ${nextStage} @ ${details.sha?.slice(0, 7) ?? "?"}\nrejected via TUI confirm dialog\n`,
				);
				return {
					content: [{ type: "text", text: `REJECTED ${nextStage} — reset ${completedStage} to in-progress` }],
				};
			}
		}

		if (details.decision === "AWAITING_HUMAN") {
			// P3 gate: stage needs human approval before marking done
			const stage = details.stage! as Stage;
			const sha = details.sha!;
			const summary = state.pendingApproval?.summary ?? event.content.map(c => c.type === "text" ? c.text : "").join("");
			const cleaned = summary.replace(/\n## question[\s\S]*$/, "");
			const confirmed = await ctx.ui.confirm(
				"pi-workflow",
				`Approve "${stage.replace(/-/g, " ")}"?\n${cleaned}\n\nApprove to proceed?`,
			);
			if (confirmed) {
				state.stages[stage].status = "done";
				state.stages[stage].sha = sha;
				state.pendingApproval = null;
				// Cascade: check if NEXT stage also needs pre-approval (same logic for wf_stage_complete and wf_approve)
				const nxt = nextGateStage(state, stage);
				if (nxt && requirePreApprovalSet().has(nxt)) {
					const artifactList = ARTIFACT_FOR_STAGE[stage].join(", ") || "source code";
					const cascadeSummary = [
						`## completed: ${stage}`,
						`- artifact(s): ${artifactList}`,
						`- sha: ${sha.slice(0, 7)}`,
						`## next stage: ${nxt}`,
						`- role: ${ROLE_FOR_STAGE[nxt]}`,
						`- expected artifacts: ${ARTIFACT_FOR_STAGE[nxt].join(", ") || "source code"}`,
						`## question`,
						`- approve starting ${nxt}? call wf_continue(stage="${nxt}", verdict="approve"|"reject", note?)`,
					].join("\n");
					state.pendingPreApproval = { nextStage: nxt, completedStage: stage, sha, summary: cascadeSummary };
					state.current = null;
					saveState(state);
					const cascadeCleaned = cascadeSummary.replace(/\n## question[\s\S]*$/, "");
					const cascadeConfirmed = await ctx.ui.confirm(
						"pi-workflow",
						`Approve starting "${nxt.replace(/-/g, " ")}"?\n${cascadeCleaned}\n\nApprove to proceed?`,
					);
					if (cascadeConfirmed) {
						state.pendingPreApproval = null;
						saveState(state);
						return {
							content: [{ type: "text", text: `APPROVED (human) ${stage} @ ${sha.slice(0, 7)}\nPRE-APPROVED ${nxt} — director may now call wf_stage_start("${nxt}")` }],
						};
					} else {
						state.stages[stage].status = "in-progress";
						state.current = stage;
						state.pendingPreApproval = null;
						saveState(state);
						fs.appendFileSync(
							path.join(artifactsDir(), "decisions.md"),
							`\n## pre-approval rejection (UI cascade): ${nxt} @ ${sha.slice(0, 7)}\nrejected via TUI confirm dialog\n`,
						);
						return {
							content: [{ type: "text", text: `REJECTED ${nxt} — reset ${stage} to in-progress` }],
						};
					}
				}
				state.current = nxt;
				saveState(state);
				return {
					content: [{ type: "text", text: `APPROVED (human) ${stage} @ ${sha.slice(0, 7)}` }],
				};
			} else {
				state.stages[stage].status = "in-progress";
				state.pendingApproval = null;
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## human rejection (UI): ${stage} @ ${sha.slice(0, 7)}\nrejected via TUI confirm dialog\n`,
				);
				return {
					content: [{ type: "text", text: `REJECTED ${stage} — reset to in-progress` }],
				};
			}
		}

		return undefined;
	});

	// --- tool_result hook: P1-2 mechanical read interception (opt-in) ---
	// Unlike tool_call (block-only), tool_result CAN substitute a tool's content. When
	// config.interceptReads is on and a role is active, a full-file `read` of a source that
	// already has FRESH knowledge fragments (mtime+size+content-hash match) returns the
	// fragment(s) instead of the raw body — the token win the plan wanted, enforced
	// mechanically. Guardrails (why this is safe):
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
		const header = `cached analysis (source unchanged — hash-verified) — re-run read with an offset to force raw source.\n\n`;
		return { content: [{ type: "text", text: header + sections.join("\n\n") }] };
	});
}
