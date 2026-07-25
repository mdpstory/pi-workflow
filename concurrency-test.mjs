// Proves two workflows (different PI_WORKFLOW_ID) can run concurrently in
// the same repo: isolated lock, state, and artifacts; cross-namespace writes
// hard-blocked regardless of role.
// Run: node /home/vivo/Notes/.pi/extensions/pi-workflow/concurrency-test.mjs

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-concurrency-"));
process.chdir(sandbox);
console.log("sandbox:", sandbox);

const tools = new Map();
const hooks = new Map();
const api = {
	registerTool(t) { tools.set(t.name, t); },
	on(event, fn) { hooks.set(event, fn); },
};

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

async function call(name, params = {}) {
	const t = tools.get(name);
	const r = await t.execute("id-" + name, params);
	return r;
}
async function hook(toolName, input) {
	return hooks.get("tool_call")({ toolName, input }, {});
}
function assert(cond, msg) {
	if (!cond) { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; }
	else console.log(`  ✓ ${msg}`);
}

console.log("\n=== A: feature session inits workflow id=feature-x ===");
process.env.PI_WORKFLOW_ROLE = "director";
process.env.PI_WORKFLOW_ID = "feature-x";
let r = await call("wf_init");
assert(r.details.ok === true, "feature-x director init OK");
assert(fs.existsSync(".workflow/feature-x/state.json"), "feature-x has its own state.json");

console.log("\n=== B: notifications session inits workflow id=notifications (same repo, same time) ===");
process.env.PI_WORKFLOW_ID = "notifications";
r = await call("wf_init");
assert(r.details.ok === true, "notifications director init OK — NOT blocked by feature-x's lock");
assert(fs.existsSync(".workflow/notifications/state.json"), "notifications has its own state.json");
assert(fs.existsSync(".workflow/feature-x/state.json"), "feature-x state.json untouched");

console.log("\n=== C: each workflow stage-machine is independent ===");
process.env.PI_WORKFLOW_ID = "feature-x";
await call("wf_stage_start", { stage: "planning" });
process.env.PI_WORKFLOW_ID = "notifications";
let s = await call("wf_status");
assert(/current: —/.test(s.content[0].text), "notifications stage machine unaffected by feature-x's stage_start");

console.log("\n=== D: cross-namespace write is hard-blocked even for engineer ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
process.env.PI_WORKFLOW_ID = "notifications";
let h = await hook("write", { path: ".workflow/feature-x/artifacts/clarifications.md" });
assert(h?.block, "notifications-engineer BLOCKED from writing feature-x's artifacts");
h = await hook("write", { path: ".workflow/notifications/artifacts/clarifications.md" });
assert(!h?.block, "notifications-engineer may write its own artifacts/clarifications.md");

console.log("\n=== E: same director trying to init same id twice while alive → BLOCKED ===");
process.env.PI_WORKFLOW_ROLE = "director";
process.env.PI_WORKFLOW_ID = "feature-x";
// Simulate a foreign live pid holding the lock: process.ppid is guaranteed
// alive (it's this test's own parent process) and guaranteed != process.pid.
const lockPath = ".workflow/feature-x/director.lock";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
fs.writeFileSync(lockPath, JSON.stringify({ ...lock, pid: process.ppid }));
r = await call("wf_init");
assert(r.details.decision === "LOCKED", "second feature-x director BLOCKED by live foreign lock");
assert(/PI_WORKFLOW_ID/.test(r.content[0].text), "lock message suggests distinct PI_WORKFLOW_ID");

console.log(process.exitCode ? "\n✗ some assertions FAILED" : "\n✓ all concurrency assertions passed");
