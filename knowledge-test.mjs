// Proves wf_knowledge_put/get (successor to the retired wf_context_append/context.md):
// (1) concurrent parallel-engineer fragments never clobber each other — each is its own
//     immutable file, unlike the old single-file-append design (2) unassigned/no-role
//     callers are denied (3) freshness filtering — a fragment about a file that has since
//     changed is reported stale and excluded (4) general vs task scope route to different
//     storage roots.
// Run: node /home/vivo/Notes/.pi/extensions/pi-workflow/context-append-test.mjs

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-knowledge-"));
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
fs.writeFileSync("__stub_pi_agent.mjs", `export const isReadToolResult = (e) => e && e.toolName === "read";`);

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
await call("wf_init");

fs.mkdirSync("src", { recursive: true });
for (let i = 0; i < 20; i++) fs.writeFileSync(`src/file${i}.ts`, `// file ${i}\n`);

console.log("\n=== A: 20 concurrent 'parallel engineer' fragments — none lost, none corrupted ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
const N = 20;
const results = await Promise.all(
	Array.from({ length: N }, (_, i) => call("wf_knowledge_put", { file: `src/file${i}.ts`, note: `entry-${i}: does X`, scope: "task" })),
);
assert(results.every((r) => r.details.ok === true), "all 20 concurrent puts reported ok");

for (let i = 0; i < N; i++) {
	const r = await call("wf_knowledge_get", { file: `src/file${i}.ts` });
	assert(r.content[0].text.includes(`entry-${i}: does X`), `fragment for file${i}.ts present and intact (own file — no clobbering)`);
}

console.log("\n=== B: no role claimed → denied ===");
delete process.env.PI_WORKFLOW_ROLE;
let r = await call("wf_knowledge_put", { file: "src/file0.ts", note: "should be denied", scope: "task" });
assert(r.details.ok === false, "unassigned session denied wf_knowledge_put");
r = await call("wf_knowledge_get", { file: "src/file0.ts" });
assert(r.details.ok === false, "unassigned session denied wf_knowledge_get");

console.log("\n=== C: staleness — fragment excluded once source file changes ===");
process.env.PI_WORKFLOW_ROLE = "engineer";
await call("wf_knowledge_put", { file: "src/file1.ts", note: "note about original content", scope: "task" });
let g = await call("wf_knowledge_get", { file: "src/file1.ts" });
assert(g.content[0].text.includes("note about original content"), "fresh fragment returned before file changes");
fs.writeFileSync("src/file1.ts", "// changed content, different size\n");
g = await call("wf_knowledge_get", { file: "src/file1.ts" });
assert(!g.content[0].text.includes("note about original content"), "stale fragment excluded after file changed");
assert(/stale/i.test(g.content[0].text), "stale-count note surfaced");

console.log("\n=== D: general vs task scope route to distinct storage roots ===");
await call("wf_knowledge_put", { file: "src/file2.ts", note: "durable general note", scope: "general" });
assert(fs.existsSync(".workflow/shared/knowledge/src__file2.ts"), "general-scope fragment under .workflow/shared/knowledge/");
const taskDirFiles = fs.readdirSync(".workflow/parallel-feat/knowledge/src__file2.ts");
assert(taskDirFiles.every((f) => !fs.readFileSync(path.join(".workflow/parallel-feat/knowledge/src__file2.ts", f), "utf8").includes("durable general note")), "general-scope note NOT duplicated into task-scope storage");
g = await call("wf_knowledge_get", { file: "src/file2.ts" });
assert(g.content[0].text.includes("durable general note"), "general-scope fragment retrievable via wf_knowledge_get");
assert(/General \(repo-wide\)/.test(g.content[0].text), "general fragment labeled as repo-wide");

console.log("\n=== E: P1-2 read interception via tool_result hook (opt-in) ===");
const onResult = hooks.get("tool_result");
assert(typeof onResult === "function", "tool_result hook is registered");
process.env.PI_WORKFLOW_ROLE = "engineer";
fs.writeFileSync("src/hot.ts", "// hot file original\n");
await call("wf_knowledge_put", { file: "src/hot.ts", note: "HOTNOTE: analyzed already", scope: "task" });
const rawContent = [{ type: "text", text: "// hot file original\n" }];
const mkEvent = (input) => ({ toolName: "read", isError: false, input, content: rawContent });

// flag OFF (no config) → passthrough
let res = await onResult(mkEvent({ path: "src/hot.ts" }), {});
assert(res === undefined, "interception OFF by default → read passes through untouched");

// flag ON
fs.mkdirSync(".pi", { recursive: true });
fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify({ interceptReads: true }));
res = await onResult(mkEvent({ path: "src/hot.ts" }), {});
assert(res && res.content[0].text.includes("HOTNOTE"), "full read substituted with fresh fragment when interceptReads on");
assert(res.content[0].text.includes("re-run read with an offset"), "substituted content carries escape-hatch header");

// escape hatch: offset present → raw source
res = await onResult(mkEvent({ path: "src/hot.ts", offset: 1 }), {});
assert(res === undefined, "passing offset bypasses interception (raw source)");

// stale fragment → no interception
fs.writeFileSync("src/hot.ts", "// hot file CHANGED bigger now\n");
res = await onResult(mkEvent({ path: "src/hot.ts" }), {});
assert(res === undefined, "stale fragment (file changed) → read passes through to raw source");

// unassigned → no interception
delete process.env.PI_WORKFLOW_ROLE;
fs.writeFileSync("src/hot.ts", "// hot file original\n"); // restore fresh, but no role
res = await onResult(mkEvent({ path: "src/hot.ts" }), {});
assert(res === undefined, "unassigned session → no interception");

console.log(process.exitCode ? "\n✗ some assertions FAILED" : "\n✓ all wf_knowledge assertions passed");
