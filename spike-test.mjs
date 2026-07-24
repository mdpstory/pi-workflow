// Viability spike driver.
// Loads the extension with a mock ExtensionAPI and exercises every gate.
// Run: cd /tmp/wf-spike && node /home/vivo/Notes/.pi/extensions/pi-workflow/spike-test.mjs

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Fresh sandbox repo
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-spike-"));
process.chdir(sandbox);
console.log("sandbox:", sandbox);

// Stub the two workspace packages the extension imports (only what we need)
const stubs = new Map();
stubs.set("@earendil-works/pi-ai", {
	StringEnum: (values) => ({ type: "string", enum: values }),
	Type: {
		Object: (shape) => ({ type: "object", properties: shape }),
		String: (opts) => ({ type: "string", ...opts }),
	},
});
stubs.set("@earendil-works/pi-coding-agent", {});

// Mock ExtensionAPI
const tools = new Map();
const hooks = new Map();
const api = {
	registerTool(t) {
		tools.set(t.name, t);
	},
	on(event, fn) {
		hooks.set(event, fn);
	},
};

// Load extension via jiti with alias-style require override
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-ai": path.join(sandbox, "__stub_pi_ai.mjs"),
		"@earendil-works/pi-coding-agent": path.join(sandbox, "__stub_pi_agent.mjs"),
	},
});

fs.writeFileSync(
	"__stub_pi_ai.mjs",
	`export const StringEnum = (v) => ({ type: "string", enum: v });
export const Type = {
  Object: (s) => ({ type: "object", properties: s }),
  String: (o) => ({ type: "string", ...o }),
  Optional: (t) => ({ ...t, optional: true }),
};`,
);
fs.writeFileSync("__stub_pi_agent.mjs", "export {};");

const extModule = await jiti.import("/home/vivo/Notes/.pi/extensions/pi-workflow/index.ts");
const factory = extModule.default || extModule;
factory(api);

console.log("loaded tools:", [...tools.keys()]);
console.log("loaded hooks:", [...hooks.keys()]);

// ---- helpers ----
async function call(name, params = {}) {
	const t = tools.get(name);
	if (!t) throw new Error(`no tool: ${name}`);
	const r = await t.execute("id-" + name, params);
	const txt = r.content?.[0]?.text ?? "";
	console.log(`  ${name}(${JSON.stringify(params)}) → ${txt.split("\n")[0]}`);
	return r;
}
async function hook(toolName, input) {
	const fn = hooks.get("tool_call");
	const r = await fn({ toolName, input }, {});
	if (r?.block) console.log(`  hook BLOCK ${toolName} ${input.path}: ${r.reason}`);
	else console.log(`  hook PASS  ${toolName} ${input.path}`);
	return r;
}
function assert(cond, msg) {
	if (!cond) {
		console.error(`✗ FAIL: ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`  ✓ ${msg}`);
	}
}

// ---- scenarios ----

console.log("\n=== 1. director init ===");
process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_init");
assert(fs.existsSync(".workflow/default/state.json"), "state.json created");
assert(fs.existsSync(".workflow/default/artifacts/plan.md"), "plan.md stub created in artifacts/");

console.log("\n=== 2. non-director may NOT init ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
const r = await call("wf_init");
assert(r.details.ok === false, "engineer denied wf_init");

console.log("\n=== 3. role path allowlist ===");
process.env.PI_WORKFLOW_ROLE = "planner";
let h = await hook("write", { path: ".workflow/default/artifacts/plan.md" });
assert(!h?.block, "planner may write .workflow/artifacts/plan.md");
h = await hook("write", { path: ".workflow/default/artifacts/architecture.md" });
assert(h?.block, "planner BLOCKED from architecture.md");

process.env.PI_WORKFLOW_ROLE = "engineer";
h = await hook("write", { path: "src/foo.ts" });
assert(!h?.block, "engineer may write source");
h = await hook("write", { path: ".workflow/default/artifacts/plan.md" });
assert(h?.block, "engineer BLOCKED from plan.md");
h = await hook("write", { path: ".workflow/default/state.json" });
assert(h?.block, "engineer BLOCKED from .workflow/ state files");

process.env.PI_WORKFLOW_ROLE = "director";
h = await hook("write", { path: ".workflow/default/state.json" });
assert(!h?.block, "director may write .workflow/");
h = await hook("write", { path: "src/foo.ts" });
assert(h?.block, "director BLOCKED from source code");

console.log("\n=== 4. stage start / complete gating ===");
process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_stage_start", { stage: "planning" });
// Try to complete without artifacts
let rc = await call("wf_stage_complete", { stage: "planning", sha: "abc1234" });
assert(rc.details.ok === false, "planning complete BLOCKED — plan.md is stub");

// Planner writes real content
process.env.PI_WORKFLOW_ROLE = "planner";
fs.writeFileSync(".workflow/default/artifacts/plan.md", "# plan\n- do the thing\n");
fs.writeFileSync(".workflow/default/artifacts/tasks.md", "# tasks\n- T1: do the thing\n");

process.env.PI_WORKFLOW_ROLE = "director";
rc = await call("wf_stage_complete", { stage: "planning", sha: "abc1234" });
assert(rc.details.ok === true, "planning complete APPROVED with real artifacts");

// Skip to architecture without doing research → BLOCK
rc = await call("wf_stage_start", { stage: "architecture" });
assert(rc.details.ok === false, "architecture start BLOCKED — research not done");

console.log("\n=== 5. CLR gate blocks writes ===");
process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_stage_start", { stage: "research" });
process.env.PI_WORKFLOW_ROLE = "scout";
const clr = await call("wf_clr_open", { stage: "research", question: "which db?" });
const clrId = clr.details.id;
// Now scout should be BLOCKED from writing research.md
h = await hook("write", { path: ".workflow/default/artifacts/research.md" });
assert(h?.block, `scout BLOCKED from research.md while ${clrId} open`);
// clarifications.md still allowed
h = await hook("write", { path: ".workflow/default/artifacts/clarifications.md" });
assert(!h?.block, "clarifications.md still writable while CLR open");

// Director resolves
process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_clr_resolve", { id: clrId, resolution: "use sqlite" });
process.env.PI_WORKFLOW_ROLE = "scout";
h = await hook("write", { path: ".workflow/default/artifacts/research.md" });
assert(!h?.block, "scout unblocked after CLR resolved");

console.log("\n=== 6. retry counters ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
let rb = await call("wf_retry_bump", { key: "defect-x" });
assert(rb.details.decision === "OK" && rb.details.bumps === 1, "bump 1 → OK");
rb = await call("wf_retry_bump", { key: "defect-x" });
assert(rb.details.bumps === 2, "bump 2");
rb = await call("wf_retry_bump", { key: "defect-x" });
assert(rb.details.decision === "DIRECTOR_RULE", "bump 3 → DIRECTOR_RULE");

let rr = await call("wf_retry_rule", { key: "defect-x", ruling: "try again with X" });
assert(rr.details.ok === false, "engineer denied wf_retry_rule");

process.env.PI_WORKFLOW_ROLE = "director";
rr = await call("wf_retry_rule", { key: "defect-x", ruling: "try again with X" });
assert(rr.details.ruled === 1 && rr.details.bumps === 0, "ruling 1 → bumps reset");
assert(fs.readFileSync(".workflow/default/artifacts/decisions.md", "utf8").includes("ruling on defect-x"), "decisions.md logged");

process.env.PI_WORKFLOW_ROLE = "engineer";
await call("wf_retry_bump", { key: "defect-x" });
await call("wf_retry_bump", { key: "defect-x" });
await call("wf_retry_bump", { key: "defect-x" });
process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_retry_rule", { key: "defect-x", ruling: "pivot" });
process.env.PI_WORKFLOW_ROLE = "engineer";
await call("wf_retry_bump", { key: "defect-x" });
await call("wf_retry_bump", { key: "defect-x" });
await call("wf_retry_bump", { key: "defect-x" });
process.env.PI_WORKFLOW_ROLE = "director";
rr = await call("wf_retry_rule", { key: "defect-x", ruling: "final call" });
assert(rr.details.ruled === 3, "3rd ruling recorded");
process.env.PI_WORKFLOW_ROLE = "engineer";
rb = await call("wf_retry_bump", { key: "defect-x" });
assert(rb.details.decision === "HUMAN", "post-3-rulings bump → HUMAN");

console.log("\n=== 7b. trivial-task skip ===");
process.env.PI_WORKFLOW_ROLE = "director";
// research is in-progress from scenario 5. Skip it + task-breakdown + architecture.
let rSkip = await call("wf_stage_complete", { stage: "research", sha: "deadbee", skip: "trivial: one-line fix" });
assert(rSkip.details.ok === true && rSkip.details.decision === "SKIPPED", "skip APPROVED");
assert(rSkip.details.skipped.join(",") === "research,task-breakdown,architecture", "skipped research→architecture");
const sSkip = await call("wf_status");
assert(/current: implementation/.test(sSkip.content[0].text), "current jumped to implementation");
assert(fs.readFileSync(".workflow/default/artifacts/decisions.md", "utf8").includes("trivial-task skip"), "decisions.md logs skip");
// Skip on implementation itself → denied
let rSkipBad = await call("wf_stage_complete", { stage: "implementation", sha: "deadbee", skip: "nope" });
assert(rSkipBad.details.ok === false, "skip on implementation denied");

console.log("\n=== 8. 50-tool-call ceiling ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
// Drive well past the 50 cap. hook fn counts every call.
for (let i = 0; i < 50; i++) {
	await hooks.get("tool_call")({ toolName: "write", input: { path: "src/x.ts" } }, {});
}
const rNonWrite = await hooks.get("tool_call")({ toolName: "bash", input: {} }, {});
assert(rNonWrite?.block && /ceiling/.test(rNonWrite.reason), "non-write BLOCKED after 50-call ceiling");
// Push far past the grace window to trigger hard stop.
let hardStopped = false;
for (let i = 0; i < 20; i++) {
	const r = await hooks.get("tool_call")({ toolName: "write", input: { path: "src/x.ts" } }, {});
	if (r?.block && /hard stop/.test(r.reason)) hardStopped = true;
}
assert(hardStopped, "write BLOCKED with hard-stop after grace margin");

console.log("\n=== 7. wf_status ===");
const s = await call("wf_status");
console.log(s.content[0].text);

console.log(process.exitCode ? "\n✗ some assertions FAILED" : "\n✓ all assertions passed");
