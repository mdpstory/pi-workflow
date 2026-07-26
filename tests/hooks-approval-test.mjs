// tool_result hook approval-interception regression test.
// Covers: the TUI confirm/reject-note path in hooks.ts resolves gates via the same
// lib/gates.ts helpers as wf_approve/wf_continue — architecture stamping, decisions.md
// logging (including the human's reject note instead of a placeholder string), the P3->P4
// cascade, role-gating (only director/unassigned may resolve via dialog), and the stale
// pendingApproval/pendingPreApproval mismatch guards.
// Run: node hooks-approval-test.mjs

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.PI_WORKFLOW_ID = "default";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-hook-"));
process.env.HOME = sandbox;
process.chdir(sandbox);
fs.mkdirSync(".pi", { recursive: true });
fs.writeFileSync(
	".pi/pi-workflow.json",
	// architecture is in requireApproval so the P3 reject branch below is GUARANTEED to run —
	// do not make that branch conditional on the decision, a false guard silently asserts nothing.
	JSON.stringify({ skipStages: ["research"], requireApproval: ["task-breakdown", "architecture"], requirePreApproval: ["implementation"] }),
);

fs.writeFileSync(
	"__stub_pi_ai.mjs",
	`export const StringEnum = (v) => ({ type: "string", enum: v });
export const Type = {
  Object: (s) => ({ type: "object", properties: s }),
  String: (o) => ({ type: "string", ...o }),
  Optional: (t) => ({ ...t, optional: true }),
  Boolean: (o) => ({ type: "boolean", ...o }),
};`,
);
fs.writeFileSync("__stub_pi_agent.mjs", "export const isReadToolResult = () => false;");

const tools = new Map();
const hookHandlers = new Map();
const api = {
	registerTool: (t) => tools.set(t.name, t),
	on: (name, fn) => {
		if (!hookHandlers.has(name)) hookHandlers.set(name, []);
		hookHandlers.get(name).push(fn);
	},
};
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-ai": path.join(sandbox, "__stub_pi_ai.mjs"),
		"@earendil-works/pi-coding-agent": path.join(sandbox, "__stub_pi_agent.mjs"),
	},
});
const extModule = await jiti.import(new URL("../index.ts", import.meta.url).pathname);
(extModule.default || extModule)(api);

const call = async (name, params = {}) => {
	const r = await tools.get(name).execute("id", params);
	return { ...r, text: r.content?.[0]?.text ?? "" };
};
// Fire the tool_result hook(s) the way the harness would: toolName + full result envelope.
const fireToolResult = async (toolName, result, ctx) => {
	const handlers = hookHandlers.get("tool_result") ?? [];
	let last;
	for (const fn of handlers) {
		const r = await fn({ toolName, isError: false, content: result.content, details: result.details }, ctx);
		if (r !== undefined) last = r;
	}
	return last ? { ...last, text: last.content?.[0]?.text ?? "" } : undefined;
};

let failed = 0;
const assert = (cond, msg) => {
	if (cond) console.log(`  ✓ ${msg}`);
	else {
		failed++;
		console.error(`  ✗ FAIL: ${msg}`);
	}
};
const art = (f, body) => fs.writeFileSync(path.join(".workflow/default/artifacts", f), body);
const state = () => JSON.parse(fs.readFileSync(".workflow/default/state.json", "utf8"));
const decisions = () => fs.readFileSync(".workflow/default/artifacts/decisions.md", "utf8");

process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_init");
art("plan.md", "# plan\n- thing\n");
art("tasks.md", "# tasks\n| T1 | thing | works | - |\n");
fs.mkdirSync(".workflow/shared/artifacts", { recursive: true });
fs.writeFileSync(".workflow/shared/artifacts/architecture.md", "# architecture\n- module X\n");

const uiApprove = { hasUI: true, ui: { confirm: async () => true, input: async () => undefined } };
const uiReject = (note) => ({ hasUI: true, ui: { confirm: async () => false, input: async () => note } });

console.log("\n=== P3 gate: hook approves via confirm dialog ===");
await call("wf_stage_start", { stage: "planning" });
await call("wf_stage_complete", { stage: "planning", sha: "aaaaaaa" });
await call("wf_stage_start", { stage: "research" }); // auto-skipped by config
await call("wf_stage_start", { stage: "task-breakdown" });
let rc = await call("wf_stage_complete", { stage: "task-breakdown", sha: "bbbbbbb" });
assert(rc.details.decision === "AWAITING_HUMAN", "task-breakdown awaiting human approval");

const hookRc = await fireToolResult("wf_stage_complete", rc, uiApprove);
assert(hookRc !== undefined, "hook intercepted AWAITING_HUMAN result");
assert(/APPROVED \(human\) task-breakdown/.test(hookRc.text), "hook reports human approval");
assert(state().stages["task-breakdown"].status === "done", "task-breakdown marked done via hook");
assert(/human approval \(ui\)/i.test(decisions()) || /task-breakdown/.test(decisions()), "decisions.md got an entry for the approval");

console.log("\n=== P3 gate: hook rejects and captures the human's note ===");
await call("wf_stage_start", { stage: "architecture" });
rc = await call("wf_stage_complete", { stage: "architecture", sha: "ccccccc" });
assert(rc.details.decision === "AWAITING_HUMAN", "architecture awaiting human approval (reject branch is reachable)");

const rejectRc = await fireToolResult("wf_stage_complete", rc, uiReject("not ready, missing module Y"));
assert(/REJECTED/.test(rejectRc.text), "hook reports rejection");
assert(state().stages.architecture.status === "in-progress", "rejected stage reset to in-progress");
assert(state().pendingApproval === null, "pending approval cleared on reject");
assert(/not ready, missing module Y/.test(decisions()), "reject note captured verbatim, not a placeholder string");
assert(!/rejected via TUI confirm dialog/.test(decisions()), "no hardcoded placeholder string in decisions.md");
const readF = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
assert(/not ready, missing module Y/.test(readF(".workflow/default/bus/director.jsonl")), "rejection pushed to director's bus, not just decisions.md");
assert(/not ready, missing module Y/.test(readF(".workflow/default/bus/architect.jsonl")), "rejection pushed to owning role's bus");

console.log("\n=== P3 approve cascades straight into the P4 pre-approval dialog ===");
await call("wf_stage_start", { stage: "architecture" });
rc = await call("wf_stage_complete", { stage: "architecture", sha: "ccccccc" });
assert(rc.details.decision === "AWAITING_HUMAN", "architecture gated again after redo");
const cascadeRc = await fireToolResult("wf_stage_complete", rc, uiApprove);
assert(cascadeRc !== undefined, "hook intercepted the AWAITING_HUMAN result");
assert(/APPROVED \(human\) architecture/.test(cascadeRc.text), "P3 approval reported");
assert(/PRE-APPROVED implementation/.test(cascadeRc.text), "cascade resolved the P4 gate in the same interaction");
assert(state().stages.architecture.status === "done", "architecture done after approval");
assert(state().pendingPreApproval === null, "pre-approval cleared via cascade");

console.log("\n=== role gating: non-director/unassigned session is NOT intercepted ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
const engRc = await fireToolResult("wf_stage_complete", { content: [{ type: "text", text: "AWAITING_HUMAN\nsomething" }], details: { ok: false, decision: "AWAITING_HUMAN", stage: "task-breakdown", sha: "zzzzzzz" } }, uiApprove);
assert(engRc === undefined, "hook does not intercept for engineer role — falls through to LLM");
process.env.PI_WORKFLOW_ROLE = "director";

console.log("\n=== stale-mismatch guard: hook does not act on a decision that is no longer pending ===");
const staleRc = await fireToolResult("wf_stage_complete", { content: [{ type: "text", text: "AWAITING_HUMAN\nstale" }], details: { ok: false, decision: "AWAITING_HUMAN", stage: "task-breakdown", sha: "0000000" } }, uiApprove);
assert(staleRc === undefined || /no longer pending/.test(staleRc.text), "stale AWAITING_HUMAN result is a no-op or explicit stale message, never a silent re-approve");

console.log("\n=== no UI available: hook falls through, leaves gate untouched for the LLM/tool path ===");
const noUiRc = await fireToolResult("wf_stage_complete", rc, { hasUI: false, ui: undefined });
assert(noUiRc === undefined, "hook does not act without ctx.hasUI/ctx.ui.confirm");

console.log("\n=== rejection reaches the stage's owning role via the bus ===");
// Drive a reject through the P4 path and confirm both director and the stage owner get it.
{
	process.env.PI_WORKFLOW_ID = "busreject";
	await call("wf_init");
	const busArt = (f, b) => fs.writeFileSync(path.join(".workflow/busreject/artifacts", f), b);
	busArt("plan.md", "# plan\n- thing\n");
	busArt("tasks.md", "# tasks\n| T1 | thing | works | - |\n");
	let s = JSON.parse(fs.readFileSync(".workflow/busreject/state.json", "utf8"));
	for (const st of ["planning", "research", "task-breakdown"]) s.stages[st] = { status: "done", sha: "ddddddd" };
	s.stages.architecture = { status: "done", sha: "eeeeeee" };
	s.pendingPreApproval = { nextStage: "implementation", completedStage: "architecture", sha: "eeeeeee", summary: "## next stage: implementation\n## question\n- approve?" };
	fs.writeFileSync(".workflow/busreject/state.json", JSON.stringify(s));
	const rej = await fireToolResult(
		"wf_stage_complete",
		{ content: [{ type: "text", text: "PRE_APPROVAL_REQUIRED" }], details: { ok: false, decision: "PRE_APPROVAL_REQUIRED", stage: "architecture", nextStage: "implementation", sha: "eeeeeee" } },
		uiReject("design does not cover failure modes"),
	);
	assert(/REJECTED implementation/.test(rej.text), "P4 reject resolved via hook");
	s = JSON.parse(fs.readFileSync(".workflow/busreject/state.json", "utf8"));
	assert(s.stages.architecture.status === "in-progress", "completed stage reset to in-progress");
	const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
	assert(/design does not cover failure modes/.test(read(".workflow/busreject/bus/director.jsonl")), "director notified on bus");
	assert(/design does not cover failure modes/.test(read(".workflow/busreject/bus/architect.jsonl")), "owning role (architect) notified on bus");
}

console.log(failed ? `\n✗ ${failed} assertion(s) FAILED` : "\n✓ ALL ASSERTIONS PASSED");
process.exitCode = failed ? 1 : 0;
