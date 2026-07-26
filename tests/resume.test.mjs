// Resume-completeness regression test (Fix E / F / K / D).
// Covers: wf_status NEXT ACTION line for each resumable situation, discussion replay,
// in-flight dispatch tracking (no double-dispatch after a session death), unread bus /
// rejection-brief surfacing, the advisory (non-auto-resolving) UI gate default, and the
// denied-loop detector.
// Run: node --test tests/resume.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { boot } from "./_harness.mjs";

const h = await boot({
	prefix: "wf-resume-",
	config: { requireApproval: ["planning"], requirePreApproval: ["research"] },
});
h.setRole("director");
await h.call("wf_init");
h.artifact("plan.md", "# plan\n- a thing\n");
h.artifact("tasks.md", "# tasks\n| T1 | thing | works | - |\n");

const status = async () => (await h.call("wf_status")).text;

test("next action on a fresh workflow points at the first stage", async () => {
	assert.match(await status(), /NEXT ACTION: wf_stage_start\("planning"\)/);
});

test("next action while a stage runs tells you to dispatch, not to guess", async () => {
	await h.call("wf_stage_start", { stage: "planning" });
	assert.match(await status(), /NEXT ACTION: dispatch the role for stage "planning"/);
});

test("in-flight dispatch is recorded and surfaced so a resumed director cannot double-dispatch", async () => {
	await h.call("wf_dispatch_note", { agent: "planner", task: "write plan.md for the health endpoint", stage: "planning" });
	const t = await status();
	assert.match(t, /in-flight subagents:/);
	assert.match(t, /planner\/planning/);
	assert.match(t, /NEXT ACTION: await in-flight subagent\(s\): planner/);

	await h.call("wf_dispatch_note", { agent: "planner", task: "write plan.md for the health endpoint", done: true });
	assert.match(await status(), /in-flight subagents: none/);
});

test("next action after a human gate tells the director to relay the verdict", async () => {
	const r = await h.call("wf_stage_complete", { stage: "planning", sha: "aaaaaaa" });
	assert.equal(r.details.decision, "AWAITING_HUMAN");
	assert.match(await status(), /NEXT ACTION: present the summary to the user.*wf_approve\(stage="planning"/s);
});

test("rejection brief is surfaced as unread bus traffic", async () => {
	const r = await h.call(
		"wf_approve",
		{ stage: "planning", sha: "aaaaaaa", verdict: "reject", note: "user said: plan misses the uptime field" },
		{ hasUI: false },
	);
	assert.match(r.text, /REJECTED planning/);
	const t = await status();
	assert.match(t, /unread bus messages: [1-9]/);
	assert.match(t, /REJECTION BRIEF/);
	// cursor advanced — the same brief is not re-reported forever
	assert.match(await status(), /unread bus messages: 0/);
});

test("discussion entries are replayed in wf_status for a resumed session", async () => {
	await h.call("wf_discuss", { topic: "plan-review", proposal: "plan v2 adds uptime", userSaid: "better, go on", decision: "proceed" });
	const t = await status();
	assert.match(t, /last discussion with the user/);
	assert.match(t, /plan-review/);
	assert.match(t, /userSaid: better, go on/);
});

test("pre-approval pending yields a wf_continue next action", async () => {
	const s = h.readState();
	s.pendingApproval = null;
	s.pendingPreApproval = { nextStage: "research", completedStage: "planning", sha: "aaaaaaa", summary: "## next stage: research" };
	h.writeState(s);
	assert.match(await status(), /NEXT ACTION: ask the user whether to start "research".*wf_continue/s);
});

test("open CLR takes priority in the next action", async () => {
	const s = h.readState();
	s.pendingPreApproval = null;
	s.current = "planning";
	h.writeState(s);
	h.setRole("planner");
	await h.call("wf_clr_open", { question: "which framework?", stage: "planning" });
	h.setRole("director");
	assert.match(await status(), /NEXT ACTION: resolve blocking CLR/);
});

test("UI gate is advisory by default — the tool result passes through untouched", async () => {
	const notes = [];
	const ctx = {
		hasUI: true,
		ui: {
			confirm: async () => {
				notes.push("confirm-called");
				return true;
			},
			notify: (m) => notes.push(m),
		},
	};
	const s = h.readState();
	s.pendingApproval = { stage: "planning", sha: "ddddddd", summary: "## produced\n- plan.md\n## question\n- ok?" };
	h.writeState(s);
	const resultHooks = h.hooks.get("tool_result") ?? [];
	let out;
	for (const fn of resultHooks) {
		out = await fn(
			{
				toolName: "wf_stage_complete",
				isError: false,
				details: { decision: "AWAITING_HUMAN", stage: "planning", sha: "ddddddd" },
			},
			ctx,
		);
		if (out) break;
	}
	assert.equal(out, undefined, "hook does not substitute the result when autoResolveGateInUi is off");
	assert.equal(notes.includes("confirm-called"), false, "no inline confirm dialog resolved the gate");
	assert.equal(h.readState().pendingApproval.stage, "planning", "gate still pending for wf_approve to resolve");
});

test("denied-loop detector blocks a third identical stage call", async () => {
	const input = { stage: "documentation" };
	assert.equal(await h.toolCall("wf_stage_start", input), undefined);
	assert.equal(await h.toolCall("wf_stage_start", input), undefined);
	const third = await h.toolCall("wf_stage_start", input);
	assert.equal(third?.block, true);
	assert.match(third.reason, /denied-loop detected/);
	// different arguments reset the streak
	assert.equal((await h.toolCall("wf_stage_start", { stage: "review" }))?.block, undefined);
});

test("wf_msg_wait returns an existing message and times out honestly otherwise", async () => {
	h.setRole("engineer");
	const before = new Date(Date.now() - 1000).toISOString();
	await h.call("wf_msg_post", { to: "engineer", body: "interface agreed: HealthResponse" });
	const hit = await h.call("wf_msg_wait", { since: before, timeoutMs: 100 });
	assert.equal(hit.details.timedOut, false);
	assert.match(hit.text, /interface agreed/);

	const miss = await h.call("wf_msg_wait", { from: "nobody", timeoutMs: 50 });
	assert.equal(miss.details.timedOut, true);
	assert.match(miss.text, /fire-and-forget, not live sync/);
	h.setRole("director");
});

test("workflow with every stage done reports final sign-off", async () => {
	const s = h.readState();
	for (const k of Object.keys(s.stages)) s.stages[k] = { status: "done", sha: "aaaaaaa" };
	s.current = null;
	s.pendingApproval = null;
	s.pendingPreApproval = null;
	h.writeState(s);
	fs.writeFileSync(".workflow/default/clr-index.json", JSON.stringify({ open: [] }));
	assert.match(await status(), /NEXT ACTION: workflow complete/);
});
