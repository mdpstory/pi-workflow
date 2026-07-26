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
process.env.HOME = sandbox; // isolate from real ~/.pi/agent/pi-workflow.json (config leaks via os.homedir())
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
  Boolean: (o) => ({ type: "boolean", ...o }),
  Number: (o) => ({ type: "number", ...o }),
};`,
);
fs.writeFileSync("__stub_pi_agent.mjs", `export const isReadToolResult = (e) => e && e.toolName === "read";`);

const extModule = await jiti.import(new URL("../index.ts", import.meta.url).pathname);
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
// (P1-3) fragment dirs are now `<sanitized-basename>-<sha1(file).slice(0,8)>`, not a bare
// sanitized name — discover the actual dir instead of hardcoding the old collision-prone name.
const sharedKnowledgeEntries = fs.readdirSync(".workflow/shared/knowledge");
const file2Dir = sharedKnowledgeEntries.find((d) => d.startsWith("src__file2.ts-"));
assert(file2Dir, "general-scope fragment under .workflow/shared/knowledge/<file2 fragment dir>");
const taskDirPath = path.join(".workflow/parallel-feat/knowledge", file2Dir);
const taskDirFiles = fs.existsSync(taskDirPath) ? fs.readdirSync(taskDirPath) : [];
assert(taskDirFiles.every((f) => !fs.readFileSync(path.join(taskDirPath, f), "utf8").includes("durable general note")), "general-scope note NOT duplicated into task-scope storage");
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

// P0-2: interceptReads now defaults to true (no config needed) → substituted
let res = await onResult(mkEvent({ path: "src/hot.ts" }), {});
assert(res && res.content[0].text.includes("HOTNOTE"), "interception ON by default (P0-2) → fresh fragment substituted");

// explicit flag ON still works too
fs.mkdirSync(".pi", { recursive: true });
fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify({ interceptReads: true }));
res = await onResult(mkEvent({ path: "src/hot.ts" }), {});
assert(res && res.content[0].text.includes("HOTNOTE"), "full read substituted with fresh fragment when interceptReads on");
assert(res.content[0].text.includes("re-run read with { offset: 1 }"), "substituted content carries escape-hatch header");
assert(/about to EDIT/.test(res.content[0].text), "substituted content warns against editing from fragments (Fix H)");

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

// explicit opt-out still respected
fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify({ interceptReads: false }));
process.env.PI_WORKFLOW_ROLE = "engineer";
res = await onResult(mkEvent({ path: "src/hot.ts" }), {});
assert(res === undefined, "interceptReads: false in config disables interception");
fs.writeFileSync(".pi/pi-workflow.json", JSON.stringify({ interceptReads: true }));

console.log("\n=== F: P1-1 coverage listing (wf_knowledge_get with no file) ===");
const cov = await call("wf_knowledge_get", {});
assert(cov.content[0].text.includes("src/file2.ts"), "coverage listing includes previously-analyzed file");
assert(cov.content[0].text.includes("path | scope | fragments | fresh?"), "coverage listing has table header");
assert(cov.content[0].text.includes("general") && cov.content[0].text.includes("task"), "coverage listing shows both scopes");

console.log("\n=== G: P1-2 fragment cap — 6 puts on one file → 3 newest + omission note ===");
fs.writeFileSync("src/capped.ts", "// capped file\n");
for (let i = 0; i < 6; i++) {
	await call("wf_knowledge_put", { file: "src/capped.ts", note: `note number ${i}`, scope: "task" });
	await new Promise((r) => setTimeout(r, 2)); // ensure distinct `written` timestamps
}
const capped = await call("wf_knowledge_get", { file: "src/capped.ts" });
const text = capped.content[0].text;
assert(text.includes("note number 5") && text.includes("note number 3"), "newest 3 fragments present");
assert(!text.includes("note number 0"), "oldest fragment dropped past cap");
assert(/older fragment\(s\) omitted/.test(text), "omission note present");

console.log("\n=== H: P1-3 bash pager bypass blocked when fresh fragment exists ===");
const onCall = hooks.get("tool_call");
assert(typeof onCall === "function", "tool_call hook is registered");
fs.writeFileSync("src/bypass.ts", "// bypass file\n");
await call("wf_knowledge_put", { file: "src/bypass.ts", note: "already analyzed", scope: "task" });
let block = await onCall({ toolName: "bash", input: { command: "cat src/bypass.ts" } }, {});
assert(block && block.block && /cached analysis exists/.test(block.reason), "bash cat on fresh-fragment file blocked");
block = await onCall({ toolName: "bash", input: { command: "grep -n foo src/bypass.ts" } }, {});
assert(!block, "bash grep still allowed");
block = await onCall({ toolName: "bash", input: { command: "head -n5 src/bypass.ts" } }, {});
assert(block && block.block, "bash head on fresh-fragment file blocked");
fs.writeFileSync("src/bypass.ts", "// bypass file CHANGED\n");
block = await onCall({ toolName: "bash", input: { command: "cat src/bypass.ts" } }, {});
assert(!block, "bash cat allowed once fragment is stale");

// --- Fix H: engineer reading a tasks.md target gets RAW source (fragments would break edits) ---
console.log("\n=== Fix H: engineer edit-target bypass ===");
fs.mkdirSync(`.workflow/${process.env.PI_WORKFLOW_ID}/artifacts`, { recursive: true });
fs.writeFileSync(`.workflow/${process.env.PI_WORKFLOW_ID}/artifacts/tasks.md`, "# tasks\n| T1 | patch src/target.ts | works | - |\n");
fs.writeFileSync("src/target.ts", "// target file\n");
process.env.PI_WORKFLOW_ROLE = "director";
await call("wf_knowledge_put", { file: "src/target.ts", note: "TARGETNOTE: analyzed already", scope: "task" });
process.env.PI_WORKFLOW_ROLE = "reviewer";
res = await onResult(mkEvent({ path: "src/target.ts" }), {});
assert(res && res.content[0].text.includes("TARGETNOTE"), "non-engineer roles still get the cached fragment");
process.env.PI_WORKFLOW_ROLE = "engineer";
res = await onResult(mkEvent({ path: "src/target.ts" }), {});
assert(res === undefined, "engineer read of a tasks.md target is NOT intercepted");

console.log(process.exitCode ? "\n✗ some assertions FAILED" : "\n✓ all wf_knowledge assertions passed (incl. Fix H)");
