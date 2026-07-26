// wf_discuss (Fix A) + discussion gate (Fix B) regression test.
// Covers: append/read/replace semantics, director-only writes, durability across a
// simulated session death, the implementation gate, and the trivial-skip gate.
// Run: node --test tests/discussion.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { boot } from "./_harness.mjs";

const h = await boot({ prefix: "wf-discuss-", config: {} });
h.setRole("director");
await h.call("wf_init");

test("wf_discuss appends a durable, parseable entry", async () => {
	const r = await h.call("wf_discuss", {
		topic: "kickoff",
		proposal: "add GET /health",
		userSaid: "yes and include uptime",
		decision: "proceed",
	});
	assert.match(r.text, /logged discussion "kickoff"/);
	const raw = fs.readFileSync(".workflow/default/discussion.md", "utf8");
	assert.match(raw, /## \[\d{4}-\d\d-\d\dT[\d:.]+Z\] kickoff/);
	assert.match(raw, /- userSaid: yes and include uptime/);
});

test("wf_discuss with no args reads the log back (any role)", async () => {
	h.setRole("engineer");
	const r = await h.call("wf_discuss", {});
	assert.match(r.text, /kickoff/);
	assert.match(r.text, /userSaid: yes and include uptime/);
	h.setRole("director");
});

test("non-director may not write the discussion log", async () => {
	h.setRole("engineer");
	const r = await h.call("wf_discuss", { topic: "sneaky", proposal: "let me approve myself" });
	assert.equal(r.details.ok, false);
	assert.match(r.text, /director only/);
	h.setRole("director");
});

test("entry without userSaid is flagged as an open question", async () => {
	const r = await h.call("wf_discuss", { topic: "arch-choice", proposal: "sqlite or postgres?" });
	assert.match(r.text, /OPEN question/);
});

test("implementation is blocked until 2 discussion entries exist", async () => {
	h.artifact("plan.md", "# plan\n- health endpoint\n");
	h.artifact("tasks.md", "# tasks\n| T1 | handler | 200 ok | - |\n");
	h.artifact("research.md", "# research\n- express app\n");
	fs.mkdirSync(".workflow/shared/artifacts", { recursive: true });
	fs.writeFileSync(".workflow/shared/artifacts/architecture.md", "# architecture\n- handler module\n");

	// Fresh workflow so the discussion log starts empty.
	process.env.PI_WORKFLOW_ID = "gated";
	await h.call("wf_init");
	const s = h.readState();
	for (const st of ["planning", "research", "task-breakdown", "architecture"]) s.stages[st] = { status: "done", sha: "aaaaaaa" };
	h.writeState(s);

	let r = await h.call("wf_stage_start", { stage: "implementation" });
	assert.equal(r.details.ok, false);
	assert.match(r.text, /0\/2 discussion entries/);

	await h.call("wf_discuss", { topic: "kickoff", proposal: "health endpoint", userSaid: "yes", decision: "proceed" });
	r = await h.call("wf_stage_start", { stage: "implementation" });
	assert.equal(r.details.ok, false, "one entry is still not enough");

	await h.call("wf_discuss", { topic: "impl-scope", proposal: "T1 only, no auth", userSaid: "go", decision: "proceed" });
	r = await h.call("wf_stage_start", { stage: "implementation" });
	assert.equal(r.details.ok, true, "two entries unblock implementation");
});

test("gate is disableable via requireDiscussionBeforeImpl:false", async () => {
	fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify({ requireDiscussionBeforeImpl: false }));
	process.env.PI_WORKFLOW_ID = "ungated";
	await h.call("wf_init");
	const s = h.readState();
	for (const st of ["planning", "research", "task-breakdown", "architecture"]) s.stages[st] = { status: "done", sha: "aaaaaaa" };
	h.writeState(s);
	const r = await h.call("wf_stage_start", { stage: "implementation" });
	assert.equal(r.details.ok, true);
	fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify({}));
});

test("trivial-task skip requires a trivial-scope discussion", async () => {
	process.env.PI_WORKFLOW_ID = "trivial";
	await h.call("wf_init");
	await h.call("wf_stage_start", { stage: "planning" });
	let r = await h.call("wf_stage_complete", { stage: "planning", sha: "abcdef1", skip: "one-line typo" });
	assert.equal(r.details.ok, false);
	assert.match(r.text, /trivial-scope/);

	await h.call("wf_discuss", { topic: "trivial-scope", proposal: "treating as trivial: typo fix", userSaid: "yep, trivial" });
	r = await h.call("wf_stage_complete", { stage: "planning", sha: "abcdef1", skip: "one-line typo" });
	assert.equal(r.details.decision, "SKIPPED");
});

test("discussion survives a simulated session death (fresh read from disk)", async () => {
	process.env.PI_WORKFLOW_ID = "default";
	const r = await h.call("wf_discuss", {});
	assert.match(r.text, /kickoff/, "original workflow's discussion still on disk");
	assert.equal(r.details.entries.length >= 2, true);
});
