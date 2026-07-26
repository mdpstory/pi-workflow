// ---- computed "what do I do next" line for wf_status (Fix E / F12) ----
// A resumed director used to have to re-derive its next move from raw state every time.
// This collapses state + CLRs + gates + discussion requirements into one imperative line.
import { requireDiscussionBeforeImpl } from "./config.ts";
import { STAGES, type Stage, stageIndex } from "./constants.ts";
import { discussionCount } from "./discussion.ts";
import { listInflight } from "./inflight.ts";
import { clrBlocksStage, type ClrIndex, type WfState } from "./state.ts";

/** First stage that is not yet done — the one wf_stage_start should target. */
export function nextRunnableStage(state: WfState): Stage | null {
	for (const s of STAGES) if (state.stages[s]?.status !== "done") return s;
	return null;
}

export function computeNextAction(state: WfState, clr: ClrIndex): string {
	if (state.pendingApproval) {
		const { stage, sha } = state.pendingApproval;
		return `present the summary to the user, then relay their verdict: wf_approve(stage="${stage}", sha="${sha}", verdict="approve"|"reject", note="<user's exact words>")`;
	}
	if (state.pendingPreApproval) {
		const { nextStage } = state.pendingPreApproval;
		return `ask the user whether to start "${nextStage}", then relay: wf_continue(stage="${nextStage}", verdict="approve"|"reject", note="<user's exact words>")`;
	}
	const gate = clrBlocksStage(clr, state.current);
	if (gate.blocked) return `resolve blocking CLR(s) with the user, then wf_clr_resolve("${gate.ids[0]}", "<resolution>")`;
	const openUpstream = clr.open.find((c) => stageIndex(c.stage) !== -1);
	if (openUpstream) return `resolve CLR ${openUpstream.id} (${openUpstream.stage}) via wf_clr_resolve`;
	if (state.current === null) {
		const nxt = nextRunnableStage(state);
		if (!nxt) return "workflow complete — discuss final sign-off with the user (wf_discuss topic=\"final-signoff\")";
		if (nxt === "implementation" && requireDiscussionBeforeImpl() && discussionCount() < 2) {
			return `discuss scope with the user and log it (wf_discuss) — implementation is blocked until 2 discussion entries exist, then wf_stage_start("${nxt}")`;
		}
		return `wf_stage_start("${nxt}")`;
	}
	const inflight = listInflight();
	if (inflight.length) {
		return `await in-flight subagent(s): ${inflight.map((i) => i.agent).join(", ")} — do NOT re-dispatch; when done call wf_dispatch_note({done:true}) then wf_stage_complete("${state.current}", sha)`;
	}
	return `dispatch the role for stage "${state.current}" via subagent(...) (register it with wf_dispatch_note first), then wf_stage_complete("${state.current}", sha)`;
}
