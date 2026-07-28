// ---- extension hooks: tool_call (ceiling + role/CLR write gate), tool_result (P1-2 read interception) ----
import { isReadToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wfNamespaceRel, isPathAllowedForRole, isPathReadableByRole } from "./lib/access.ts";
import { bumpToolCalls, currentToolCalls, currentToolCap, resetToolCalls } from "./lib/ceiling.ts";
import { autoResolveGateInUi, loadConfig } from "./lib/config.ts";
import * as fs from "node:fs";
import { artifactPath, artifactsDir, clrIndexPath, relFromRepo, sharedArtifactsDir } from "./lib/paths.ts";
import { mintId, role, setSessionId, workflowActive } from "./lib/identity.ts";
import { freshFragments } from "./lib/knowledge.ts";
import { clrBlocksStage, isStubContent, loadClr, loadState, saveState } from "./lib/state.ts";
import { resolveApproval, resolvePreApproval } from "./lib/gates.ts";
import { ARTIFACT_MDS, type Stage } from "./lib/constants.ts";
import { writeJson } from "./lib/io.ts";
import { wfRoot } from "./lib/base-paths.ts";
import * as path from "node:path";

// --- (Fix K) denied-loop detector -------------------------------------------------
// In-process only (like the tool ceiling): a fresh session starts with a clean slate.
// "No state change" is approximated by hashing the state file's mtime+size+current stage;
// if a retry actually moved the workflow forward, the signature differs and the streak resets.
const LOOP_WINDOW_MS = 30_000;
const LOOP_LIMIT = 3;
let lastCallKey = "";
let lastCallCount = 0;
let lastCallFirstTs = 0;

function stateSignature(): string {
	const s = loadState();
	return `${s.current ?? "-"}|${Object.entries(s.stages).map(([k, v]) => `${k}:${v.status}:${v.sha ?? ""}`).join(",")}|${s.pendingApproval?.stage ?? "-"}|${s.pendingPreApproval?.nextStage ?? "-"}`;
}

function recordStageCall(toolName: string, input: unknown): { blocked: boolean; count: number; windowMs: number } {
	const now = Date.now();
	let sig = "";
	try {
		sig = stateSignature();
	} catch {
		// unreadable state — fall back to args-only identity
	}
	const key = `${toolName}:${JSON.stringify(input ?? {})}:${sig}`;
	if (key !== lastCallKey || now - lastCallFirstTs > LOOP_WINDOW_MS) {
		lastCallKey = key;
		lastCallCount = 1;
		lastCallFirstTs = now;
		return { blocked: false, count: 1, windowMs: 0 };
	}
	lastCallCount++;
	return { blocked: lastCallCount >= LOOP_LIMIT, count: lastCallCount, windowMs: now - lastCallFirstTs };
}

// (Fix H) Does tasks.md name this file as a task target? Cheap literal-substring check —
// tasks.md is a small table written by the planner, and a false positive only costs the
// engineer a full read (the safe direction).
function isTaskTarget(rel: string): boolean {
	try {
		return fs.readFileSync(artifactPath("tasks.md"), "utf8").includes(rel);
	} catch {
		return false;
	}
}

export function registerHooks(pi: ExtensionAPI) {
	// Reset tool counter on session start / switch / reload.
	// On explicit new session (pi /new), also reset workflow state so the user
	// starts with a clean slate — fresh id, stages all "todo", artifacts re-stubbed.
	pi.on("session_start", async (event, _ctx) => {
		resetToolCalls();

		// Only reset workflow on an explicit new session, not on resume/reload.
		// Skip subagents (they carry PI_WORKFLOW_ROLE env — the director owns the reset).
		if (event.reason !== "new" || process.env.PI_WORKFLOW_ROLE) return;

		// Mint fresh workflow id, overwrite .active-id marker, reset state + artifacts.
		const fresh = mintId();
		setSessionId(fresh);
		try {
			fs.mkdirSync(wfRoot(), { recursive: true });
			fs.writeFileSync(path.join(wfRoot(), ".active-id"), fresh);
		} catch { /* best-effort */ }

		// Reset workflow state to default (all stages todo, no current stage).
		const empty = loadState();
		for (const s of Object.keys(empty.stages)) {
			empty.stages[s as Stage] = { status: "todo" };
		}
		empty.current = null;
		empty.rulings = {};
		empty.pendingApproval = null;
		empty.pendingPreApproval = null;
		saveState(empty);

		// Clear CLR index.
		writeJson(clrIndexPath(), { open: [] });

		// Re-stub artifacts.
		fs.mkdirSync(artifactsDir(), { recursive: true });
		fs.mkdirSync(sharedArtifactsDir(), { recursive: true });
		for (const md of ARTIFACT_MDS) {
			const abs = artifactPath(md);
			if (!fs.existsSync(abs) || isStubContent(fs.readFileSync(abs, "utf8"))) {
				fs.writeFileSync(abs, `# ${md.replace(".md", "")}\n\n_empty_\n`);
			}
		}
	});

	// --- tool_call hook: 50-call ceiling + role + CLR gate ---
	// The 50-call ceiling and the role/CLR gate only activate once a workflow is actually
	// in play (workflowActive()) — a bare "unassigned" session (extension installed but no
	// role claimed / env set) is completely untouched. See role()/workflowActive().
	pi.on("tool_call", async (event, _ctx) => {
		// Ceiling only applies to a session with an active role.
		if (workflowActive()) bumpToolCalls();
		const toolCalls = currentToolCalls();
		const TOOL_CAP = currentToolCap();

		// (Fix K / F10) "Reason, don't flail" was skill prose only — nothing physically stopped
		// a director from re-firing a denied wf_stage_start/wf_stage_complete in a tight loop.
		// Three identical stage-transition calls inside 30s with no state change in between =>
		// blocked, with an instruction to read the previous denial and talk to the user.
		if (workflowActive() && (event.toolName === "wf_stage_start" || event.toolName === "wf_stage_complete")) {
			const loop = recordStageCall(event.toolName, event.input);
			if (loop.blocked) {
				return {
					block: true,
					reason: `pi-workflow: denied-loop detected — ${event.toolName} fired ${loop.count}× with identical arguments in ${Math.round(loop.windowMs / 1000)}s and no state change. Read the previous response, fix the actual blocker (missing artifact / open CLR / discussion gate), discuss with the user if unclear, then act. Re-firing will not change the answer.`,
				};
			}
		}

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
		// The dialogs below relay a verdict to wf_approve/wf_continue semantics. Only a
		// director (relaying) or unassigned (the human, directly) session may resolve a
		// gate this way — matches requireHumanGate() in tools/stages.ts. Guards against a
		// dispatched subagent process somehow acquiring ctx.ui and auto-approving its own gate.
		const r = role();
		if (r !== "director" && r !== "unassigned") return undefined;

		// Check for approval-decision tool results
		const details = (event as { details?: { decision?: string; stage?: string; nextStage?: string; sha?: string } }).details;
		if (!details?.decision) return undefined;
		if (details.decision !== "PRE_APPROVAL_REQUIRED" && details.decision !== "AWAITING_HUMAN") return undefined;

		// Need UI to show confirm dialog
		if (!ctx.hasUI || !ctx.ui?.confirm) return undefined;

		// (Fix D / F3) Two competing gate paths used to double-fire: this hook resolved the gate
		// inline while the director skill was simultaneously told to present the summary in chat
		// and then call wf_approve/wf_continue — whichever ran first cleared pendingApproval and
		// the other failed with "no matching pending approval". Default is now ADVISORY: show the
		// summary for visibility, leave the tool result untouched, and let the director's explicit
		// wf_approve/wf_continue call (which forces its own confirm dialog) stay authoritative.
		// Set autoResolveGateInUi:true for the old one-click inline resolve.
		if (!autoResolveGateInUi()) {
			const pending = loadState();
			const summary = pending.pendingApproval?.summary ?? pending.pendingPreApproval?.summary ?? "";
			const cleaned = summary.replace(/\n## question[\s\S]*$/, "");
			if (ctx.ui?.notify) {
				try {
					ctx.ui.notify(`pi-workflow: waiting on your decision\n${cleaned}`, "info");
				} catch {
					// display-only; never let a notify failure alter gate semantics
				}
			}
			return undefined; // tool result passes through unchanged — skill relays the verdict
		}

		const toolName = event.toolName;

		// Ask for a correction note on reject — becomes the audit-trail brief the director
		// reads before retrying, same as the note param on wf_approve/wf_continue.
		async function collectRejectNote(): Promise<string | undefined> {
			if (!ctx.ui?.input) return undefined;
			const note = await ctx.ui.input("pi-workflow", "Why? (correction note for decisions.md, optional)");
			return note?.trim() || undefined;
		}

		if (details.decision === "PRE_APPROVAL_REQUIRED" && (toolName === "wf_stage_complete" || toolName === "wf_stage_start")) {
			// P4 gate: next stage needs approval before starting
			const nextStageName = details.nextStage as Stage | undefined;
			const completedStage = details.stage as Stage | undefined;
			if (!nextStageName || !completedStage) return undefined; // malformed details — let the LLM handle it via wf_continue
			const preState = loadState();
			if (!preState.pendingPreApproval || preState.pendingPreApproval.nextStage !== nextStageName) return undefined; // stale — nothing to resolve
			const summary = preState.pendingPreApproval.summary;
			const cleaned = summary.replace(/\n## question[\s\S]*$/, "");
			const confirmed = await ctx.ui.confirm(
				"pi-workflow",
				`Approve starting "${nextStageName.replace(/-/g, " ")}"?\n${cleaned}\n\nApprove to proceed?`,
			);
			const note = confirmed ? undefined : await collectRejectNote();
			// Re-load: both confirm() and input() were awaited, state may have moved under us.
			const state = loadState();
			if (!state.pendingPreApproval || state.pendingPreApproval.nextStage !== nextStageName) {
				return { content: [{ type: "text", text: `pi-workflow: pre-approval for ${nextStageName} is no longer pending — someone else already resolved it.` }] };
			}
			// Trust STATE, not the tool-result details, for completedStage/sha: the reject path
			// resets completedStage to in-progress, so a details/state mismatch would reopen the
			// wrong stage. details is only used to identify WHICH gate this result refers to.
			const result = resolvePreApproval(state, nextStageName, state.pendingPreApproval.completedStage as Stage, state.pendingPreApproval.sha, confirmed ? "approve" : "reject", note, "ui");
			saveState(state);
			return { content: [{ type: "text", text: result.text }] };
		}

		if (details.decision === "AWAITING_HUMAN") {
			// P3 gate: stage needs human approval before marking done
			const stage = details.stage as Stage | undefined;
			const sha = details.sha;
			if (!stage || !sha) return undefined; // malformed details — let the LLM handle it via wf_approve
			const preState = loadState();
			if (!preState.pendingApproval || preState.pendingApproval.stage !== stage || preState.pendingApproval.sha !== sha) return undefined;
			const summary = preState.pendingApproval.summary;
			const cleaned = summary.replace(/\n## question[\s\S]*$/, "");
			const confirmed = await ctx.ui.confirm(
				"pi-workflow",
				`Approve "${stage.replace(/-/g, " ")}"?\n${cleaned}\n\nApprove to proceed?`,
			);
			const note = confirmed ? undefined : await collectRejectNote();
			// Re-load: confirm()/input() were awaited, state may have moved under us.
			const state = loadState();
			if (!state.pendingApproval || state.pendingApproval.stage !== stage || state.pendingApproval.sha !== sha) {
				return { content: [{ type: "text", text: `pi-workflow: approval for ${stage} is no longer pending — someone else already resolved it.` }] };
			}
			const result = resolveApproval(state, stage, sha, confirmed ? "approve" : "reject", note, "ui");
			if (result.kind !== "pre-approval-required") {
				saveState(state);
				return { content: [{ type: "text", text: result.text }] };
			}
			// Cascade: next stage also needs pre-approval — ask immediately instead of
			// leaving the LLM to relay a second dialog invitation via wf_continue.
			saveState(state);
			const cascadeCleaned = result.summary.replace(/\n## question[\s\S]*$/, "");
			const cascadeConfirmed = await ctx.ui.confirm(
				"pi-workflow",
				`Approve starting "${result.nextStage.replace(/-/g, " ")}"?\n${cascadeCleaned}\n\nApprove to proceed?`,
			);
			const cascadeNote = cascadeConfirmed ? undefined : await collectRejectNote();
			const state2 = loadState();
			if (!state2.pendingPreApproval || state2.pendingPreApproval.nextStage !== result.nextStage) {
				return { content: [{ type: "text", text: `APPROVED (human) ${stage} @ ${sha.slice(0, 7)}\npi-workflow: pre-approval for ${result.nextStage} already resolved by someone else.` }] };
			}
			const cascadeResult = resolvePreApproval(state2, result.nextStage, stage, sha, cascadeConfirmed ? "approve" : "reject", cascadeNote, "ui");
			saveState(state2);
			return { content: [{ type: "text", text: `APPROVED (human) ${stage} @ ${sha.slice(0, 7)}\n${cascadeResult.text}` }] };
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
		// (Fix H / F7) An engineer reading a file that tasks.md names as a target is about to
		// EDIT it. Fragments would make its `edit` oldText fail to match, so serve raw source.
		if (role() === "engineer" && isTaskTarget(rel)) return undefined;
		const { sections } = freshFragments(rel);
		if (!sections.length) return undefined;
		// (Fix H / F7) Explicit edit warning: an engineer that edits from fragments produces
		// broken diffs. Say exactly how to get the real bytes.
		const header =
			`cached analysis (source unchanged — hash-verified) — this is NOT the file's source text.\n` +
			`If you are about to EDIT or WRITE this file, re-run read with { offset: 1 } to force raw source. ` +
			`Editing based on fragments risks producing broken diffs (edit oldText will not match).\n\n`;
		return { content: [{ type: "text", text: header + sections.join("\n\n") }] };
	});
}
