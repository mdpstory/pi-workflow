// ---- shared approve/reject resolution for the P3 (human) and P4 (pre-approval) gates ----
// Used by both wf_approve/wf_continue (tools/stages.ts) and the TUI confirm-dialog
// interception (hooks.ts) so the two paths cannot drift: same architecture stamping,
// same decisions.md audit trail, same cascade-into-next-pre-approval logic. Callers
// are responsible for re-loading state immediately before calling (avoid stale-read
// races across an awaited confirm dialog) and for saving the state this returns.
import * as fs from "node:fs";
import * as path from "node:path";
import { currentGitSha, stampArchitecture } from "./architecture.ts";
import { postMessage } from "./bus.ts";
import { requirePreApprovalSet, skipStagesSet } from "./config.ts";
import { ARTIFACT_FOR_STAGE, nextStage, ROLE_FOR_STAGE, type Stage } from "./constants.ts";
import { artifactsDir } from "./paths.ts";
import type { WfState } from "./state.ts";

export function nextGateStage(state: WfState, from: Stage): Stage | null {
	const skip = skipStagesSet();
	let n = nextStage(from);
	while (n && (skip.has(n) || state.stages[n]?.status === "done")) n = nextStage(n);
	return n;
}

function logDecision(heading: string, body: string): void {
	fs.appendFileSync(path.join(artifactsDir(), "decisions.md"), `\n## ${heading}\n${body}\n`);
}

// A rejection resets a stage to in-progress, but decisions.md is a passive audit log —
// nothing makes the director or the re-dispatched agent actually read it. Push the
// correction brief onto the bus so it surfaces on their next wf_msg_poll, which is the
// channel dispatched subagents already use (they have no intercom identity).
function notifyRejection(stage: Stage, sha: string | undefined, note: string | undefined, source: "tool" | "ui"): void {
	const owner = ROLE_FOR_STAGE[stage];
	const body = [
		`REJECTED: ${stage} @ ${sha?.slice(0, 7) ?? "?"} (human gate, via ${source})`,
		`stage reset to in-progress — redo it addressing this correction:`,
		note ?? "(no note given — ask the human via wf_clr_open before redoing)",
	].join("\n");
	try {
		postMessage("human-gate", "director", body);
		if (owner && owner !== "director") postMessage("human-gate", owner, body);
	} catch {
		// Bus is a convenience channel; decisions.md remains the source of truth.
		// Never let a bus write failure abort an otherwise-valid gate resolution.
	}
}

function preApprovalSummary(stage: Stage, nxt: Stage, sha: string): string {
	const artifactList = ARTIFACT_FOR_STAGE[stage].join(", ") || "source code";
	return [
		`## completed: ${stage}`,
		`- artifact(s): ${artifactList}`,
		`- sha: ${sha.slice(0, 7)}`,
		`## next stage: ${nxt}`,
		`- role: ${ROLE_FOR_STAGE[nxt]}`,
		`- expected artifacts: ${ARTIFACT_FOR_STAGE[nxt].join(", ") || "source code"}`,
		`## question`,
		`- approve starting ${nxt}? call wf_continue(stage="${nxt}", verdict="approve"|"reject", note?)`,
	].join("\n");
}

export type GateResult =
	| { kind: "rejected"; text: string }
	| { kind: "approved"; text: string }
	| { kind: "pre-approval-required"; nextStage: Stage; summary: string; text: string };

// P3 gate: resolve a pending human approval for `stage`/`sha`. Mutates `state` in place;
// caller must saveState(state) after. `note` becomes the correction brief on reject —
// pass a real note whenever the caller has one (UI dialogs should prompt for it).
export function resolveApproval(state: WfState, stage: Stage, sha: string, verdict: "approve" | "reject", note: string | undefined, source: "tool" | "ui"): GateResult {
	const tag = source === "ui" ? " (UI)" : "";
	if (verdict === "reject") {
		state.pendingApproval = null;
		state.stages[stage].status = "in-progress";
		logDecision(`human rejection${tag}: ${stage} @ ${sha.slice(0, 7)}`, note ?? "(no note given)");
		notifyRejection(stage, sha, note, source);
		return { kind: "rejected", text: `REJECTED ${stage} — reset to in-progress with correction note in decisions.md` };
	}

	if (stage === "architecture") {
		const head = currentGitSha();
		if (head) stampArchitecture(head);
	}
	state.stages[stage].status = "done";
	state.stages[stage].sha = sha;
	state.pendingApproval = null;
	logDecision(`human approval${tag}: ${stage} @ ${sha.slice(0, 7)}`, "approved");

	const nxt = nextGateStage(state, stage);
	if (nxt && requirePreApprovalSet().has(nxt)) {
		const summary = preApprovalSummary(stage, nxt, sha);
		state.pendingPreApproval = { nextStage: nxt, completedStage: stage, sha, summary };
		state.current = null;
		return { kind: "pre-approval-required", nextStage: nxt, summary, text: `PRE_APPROVAL_REQUIRED\n${summary}` };
	}

	state.current = nxt;
	return { kind: "approved", text: `APPROVED (human) ${stage} @ ${sha.slice(0, 7)}` };
}

// P4 gate: resolve a pending pre-approval for `nextStage`. Mutates `state` in place;
// caller must saveState(state) after.
export function resolvePreApproval(state: WfState, nextStageName: Stage, completedStage: Stage, sha: string | undefined, verdict: "approve" | "reject", note: string | undefined, source: "tool" | "ui"): GateResult {
	const tag = source === "ui" ? " (UI)" : "";
	if (verdict === "reject") {
		state.stages[completedStage].status = "in-progress";
		state.current = completedStage;
		state.pendingPreApproval = null;
		logDecision(`pre-approval rejection${tag}: ${nextStageName} @ ${sha?.slice(0, 7) ?? "?"}`, note ?? "(no note given)");
		notifyRejection(completedStage, sha, note, source);
		return { kind: "rejected", text: `REJECTED ${nextStageName} — reset ${completedStage} to in-progress with correction note in decisions.md` };
	}
	state.pendingPreApproval = null;
	logDecision(`pre-approval${tag}: ${nextStageName}`, `approved — completed ${completedStage} @ ${sha?.slice(0, 7) ?? "?"}`);
	return { kind: "approved", text: `PRE-APPROVED ${nextStageName} — director may now call wf_stage_start("${nextStageName}")` };
}
