// Headless director-relay regression test (Fix C / F2).
// In `pi -p` (no UI) mode the director used to be able to approve its own human gates with
// zero human input. Now a relay REQUIRES note=<the user's exact words>, quoted into
// decisions.md. With a UI present the confirm() dialog still governs.
// Run: node --test tests/headless-relay.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { boot } from "./_harness.mjs";

const h = await boot({
	prefix: "wf-relay-",
	config: { requireApproval: ["planning"], requirePreApproval: ["research"], requireDiscussionBeforeImpl: false },
});
h.setRole("director");
await h.call("wf_init");
h.artifact("plan.md", "# plan\n- a thing\n");
h.artifact("tasks.md", "# tasks\n| T1 | thing | works | - |\n");

const noUiCtx = { hasUI: false };
const decisions = () => fs.readFileSync(".workflow/default/artifacts/decisions.md", "utf8");

test("stage completion halts on the human gate", async () => {
	await h.call("wf_stage_start", { stage: "planning" });
	const r = await h.call("wf_stage_complete", { stage: "planning", sha: "aaaaaaa" });
	assert.equal(r.details.decision, "AWAITING_HUMAN");
});

test("headless wf_approve without a note is denied", async () => {
	const r = await h.call("wf_approve", { stage: "planning", sha: "aaaaaaa", verdict: "approve" }, noUiCtx);
	assert.equal(r.details.ok, false);
	assert.match(r.text, /headless director-relay requires note/);
	assert.equal(h.readState().pendingApproval.stage, "planning", "gate still pending");
});

test("a too-short note is also denied", async () => {
	const r = await h.call("wf_approve", { stage: "planning", sha: "aaaaaaa", verdict: "approve", note: "ok" }, noUiCtx);
	assert.equal(r.details.ok, false);
	assert.match(r.text, />= 8 chars/);
});

test("headless relay with the user's words is accepted and quoted into decisions.md", async () => {
	const r = await h.call(
		"wf_approve",
		{ stage: "planning", sha: "aaaaaaa", verdict: "approve", note: "user said: looks good, ship the plan" },
		noUiCtx,
	);
	// research is in requirePreApproval, so approving planning cascades straight into the P4 gate
	assert.equal(r.details.decision, "PRE_APPROVAL_REQUIRED");
	assert.match(decisions(), /relayed-by-director: wf_approve verdict=approve stage=planning/);
	assert.match(decisions(), /> user said: looks good, ship the plan/);
	assert.equal(h.readState().stages.planning.status, "done");
});

test("wf_continue enforces the same rule", async () => {
	assert.equal(h.readState().pendingPreApproval.nextStage, "research");
	let r = await h.call("wf_continue", { stage: "research", verdict: "approve" }, noUiCtx);
	assert.equal(r.details.ok, false);
	assert.match(r.text, /headless director-relay requires note/);
	r = await h.call("wf_continue", { stage: "research", verdict: "approve", note: "user: yes, run research" }, noUiCtx);
	assert.equal(r.details.ok, true);
	assert.match(decisions(), /> user: yes, run research/);
});

test("a UI confirm still governs (no note needed) and a decline blocks", async () => {
	// re-open a gate by rejecting-then-redoing planning is heavy; use a synthetic pending state
	const s = h.readState();
	s.pendingApproval = { stage: "research", sha: "bbbbbbb", summary: "## produced\n- research.md" };
	h.writeState(s);
	const declineCtx = { hasUI: true, ui: { confirm: async () => false } };
	let r = await h.call("wf_approve", { stage: "research", sha: "bbbbbbb", verdict: "approve" }, declineCtx);
	assert.equal(r.details.ok, false);
	assert.match(r.text, /declined to confirm/);

	const acceptCtx = { hasUI: true, ui: { confirm: async () => true } };
	r = await h.call("wf_approve", { stage: "research", sha: "bbbbbbb", verdict: "approve" }, acceptCtx);
	assert.equal(r.details.ok, true, "UI confirmation is sufficient without a note");
});

test("an unassigned (human) session never needs a relay note", async () => {
	const s = h.readState();
	s.pendingApproval = { stage: "task-breakdown", sha: "ccccccc", summary: "## produced\n- tasks.md" };
	h.writeState(s);
	delete process.env.PI_WORKFLOW_ROLE; // the human, directly
	const r = await h.call("wf_approve", { stage: "task-breakdown", sha: "ccccccc", verdict: "approve" }, noUiCtx);
	assert.equal(r.details.ok, true);
	h.setRole("director");
});
