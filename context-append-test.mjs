// Proves wf_context_append: (1) concurrent parallel-engineer appends never
// clobber each other (2) role allowlist still applies (3) CLR gate still
// applies (4) result lands in the correct per-workflow context.md.
// Run: node /home/vivo/Notes/.pi/extensions/pi-workflow/context-append-test.mjs

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ctx-append-"));
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
	return t.execute("id-" + name, params);
}
function assert(cond, msg) {
	if (!cond) { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; }
	else console.log(`  ✓ ${msg}`);
}

process.env.PI_WORKFLOW_ROLE = "director";
process.env.PI_WORKFLOW_ID = "parallel-feat";
console.log("\n=== setup: init + reach implementation stage ===");
await call("wf_init");
const ART_FOR = {
	planning: ["plan.md", "tasks.md"],
	research: ["research.md", "context.md"],
	"task-breakdown": ["tasks.md", "context.md"],
	architecture: ["architecture.md", "context.md"],
};
function fillArtifact(name) {
	const shared = name === "architecture.md";
	const dir = shared ? ".workflow/shared/artifacts" : ".workflow/parallel-feat/artifacts";
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), `# ${name}\n\nnon-stub content for test.\n`);
}
for (const stage of ["planning", "research", "task-breakdown", "architecture"]) {
	const startRes = await call("wf_stage_start", { stage });
	if (!startRes.details.ok && !/BLOCKED/.test(startRes.content[0].text ?? "")) { /* noop */ }
	for (const art of ART_FOR[stage] ?? []) fillArtifact(art);
	const completeRes = await call("wf_stage_complete", { stage, sha: "deadbeef" });
	assert(completeRes.details.ok === true, `setup: stage ${stage} completed`);
}
const implStart = await call("wf_stage_start", { stage: "implementation" });
assert(implStart.details.ok === true, "setup: reached implementation stage");

console.log("\n=== A: 20 concurrent 'parallel engineer' appends — none lost, none corrupted ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
const N = 20;
const results = await Promise.all(
	Array.from({ length: N }, (_, i) => call("wf_context_append", { entry: `entry-${i}: src/file${i}.ts:1-10 does X` })),
);
assert(results.every((r) => r.details.ok === true), "all 20 concurrent appends reported ok");

const content = fs.readFileSync(".workflow/parallel-feat/artifacts/context.md", "utf8");
for (let i = 0; i < N; i++) {
	assert(content.includes(`entry-${i}: src/file${i}.ts:1-10 does X`), `entry-${i} present and intact (no clobbering)`);
}
// No entry should appear twice, and no entry should be truncated/merged into a neighbor.
const occurrences = (s) => (content.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
assert(occurrences("entry-0: src/file0.ts:1-10 does X") === 1, "no duplicate/partial entries from interleaved writes");

console.log("\n=== B: role allowlist still enforced (reviewer CAN write context.md, unknown role cannot) ===");
process.env.PI_WORKFLOW_ROLE = "bogus-role";
let r = await call("wf_context_append", { entry: "should be denied" });
assert(r.details.ok === false, "unknown role denied by wf_context_append");
assert(!fs.readFileSync(".workflow/parallel-feat/artifacts/context.md", "utf8").includes("should be denied"), "denied entry not written");

console.log("\n=== C: CLR gate still enforced ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
await call("wf_clr_open", { stage: "implementation", question: "blocking?" });
r = await call("wf_context_append", { entry: "should be CLR-blocked" });
assert(r.details.ok === false, "append blocked while OPEN CLR names current stage");
assert(!fs.readFileSync(".workflow/parallel-feat/artifacts/context.md", "utf8").includes("should be CLR-blocked"), "CLR-blocked entry not written");

console.log("\n=== D: empty entry rejected ===");
r = await call("wf_context_append", { entry: "   " });
assert(r.details.ok === false, "empty/whitespace-only entry rejected");

console.log(process.exitCode ? "\n✗ some assertions FAILED" : "\n✓ all wf_context_append assertions passed");
