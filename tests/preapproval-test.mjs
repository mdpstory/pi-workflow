// Pre-approval gate regression test.
// Covers: gate must never point at a skipped/already-done stage, the deny message must
// quote the GATED stage (so wf_continue matches), and the auto-skip chain must not start
// a requirePreApproval stage the user never approved.
// Run: node preapproval-test.mjs

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.PI_WORKFLOW_ID = "default";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-gate-"));
process.env.HOME = sandbox; // isolate from real ~/.pi/agent/pi-workflow.json (config leaks via os.homedir())
process.chdir(sandbox);
fs.mkdirSync(".pi", { recursive: true });
// research skipped by config; implementation gated. architecture stays runnable.
fs.writeFileSync(
	".pi/pi-workflow.json",
	JSON.stringify({ skipStages: ["research"], requirePreApproval: ["implementation"] }),
);

fs.writeFileSync(
	"__stub_pi_ai.mjs",
	`export const StringEnum = (v) => ({ type: "string", enum: v });
export const Type = {
  Object: (s) => ({ type: "object", properties: s }),
  String: (o) => ({ type: "string", ...o }),
  Optional: (t) => ({ ...t, optional: true }),
  Boolean: (o) => ({ type: "boolean", ...o }),
  Number: (o) => ({ type: "number", ...o }),
};`,
);
fs.writeFileSync("__stub_pi_agent.mjs", "export {};");

const tools = new Map();
const api = { registerTool: (t) => tools.set(t.name, t), registerCommand: () => {}, registerShortcut: () => {}, on: () => {} };
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

process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_init");
art("plan.md", "# plan\n- thing\n");
art("tasks.md", "# tasks\n| T1 | thing | works | - |\n");
fs.mkdirSync(".workflow/shared/artifacts", { recursive: true });
fs.writeFileSync(".workflow/shared/artifacts/architecture.md", "# architecture\n- module X\n");

console.log("\n=== gate targets the stage that will actually run ===");
await call("wf_stage_start", { stage: "planning" });
let rc = await call("wf_stage_complete", { stage: "planning", sha: "aaaaaaa" });
assert(rc.details.decision !== "PRE_APPROVAL_REQUIRED", "no gate for skipped research");

rc = await call("wf_stage_start", { stage: "research" });
assert(/skipped/.test(rc.text), "research auto-skipped");
rc = await call("wf_stage_complete", { stage: "task-breakdown", sha: "bbbbbbb" });
assert(rc.details.ok === true, "task-breakdown done");
rc = await call("wf_stage_start", { stage: "architecture" });
assert(rc.details.ok === true, "architecture starts un-gated");
rc = await call("wf_stage_complete", { stage: "architecture", sha: "ccccccc" });
assert(rc.details.decision === "PRE_APPROVAL_REQUIRED", "implementation gated");
assert(state().pendingPreApproval.nextStage === "implementation", "gate points at implementation");

console.log("\n=== deny message quotes the GATED stage ===");
rc = await call("wf_stage_start", { stage: "review" }); // director asks for the wrong stage
assert(/wf_continue\(stage="implementation"/.test(rc.text), "deny names the gated stage, not the requested one");

console.log("\n=== stale gate (stage already done) is dropped, not deadlocked ===");
let s = state();
s.pendingPreApproval = { nextStage: "architecture", completedStage: "task-breakdown", sha: "ccccccc", summary: "stale" };
fs.writeFileSync(".workflow/default/state.json", JSON.stringify(s));
rc = await call("wf_stage_start", { stage: "implementation" });
assert(state().pendingPreApproval === null, "stale gate cleared");

console.log("\n=== auto-skip chain cannot start a gated stage unapproved ===");
// fresh workflow where architecture is auto-skipped, so the chain lands on gated implementation
fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify({ skipStages: ["research", "architecture"], requirePreApproval: ["implementation"] }));
process.env.PI_WORKFLOW_ID = "chain";
await call("wf_init");
art("plan.md", "# plan\n- thing\n");
art("tasks.md", "# tasks\n| T1 | thing | works | - |\n");
s = JSON.parse(fs.readFileSync(".workflow/chain/state.json", "utf8"));
for (const st of ["planning", "research", "task-breakdown"]) s.stages[st] = { status: "done", sha: "ddddddd" };
fs.writeFileSync(".workflow/chain/state.json", JSON.stringify(s));
rc = await call("wf_stage_start", { stage: "architecture" });
assert(rc.details.decision === "PRE_APPROVAL_REQUIRED", "chain landing on implementation is gated");
s = JSON.parse(fs.readFileSync(".workflow/chain/state.json", "utf8"));
assert(s.stages.implementation.status !== "in-progress", "gated stage NOT started");

console.log(failed ? `\n✗ ${failed} assertion(s) FAILED` : "\n✓ ALL ASSERTIONS PASSED");
process.exitCode = failed ? 1 : 0;
