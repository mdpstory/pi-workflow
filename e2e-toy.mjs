/**
 * pi-workflow — toy end-to-end run
 *
 * Task: "add health endpoint"
 * Drives all 8 stages: planning, research, task-breakdown, architecture,
 * implementation, review, testing, documentation.
 * Uses mock pi API (same approach as spike-test.mjs).
 *
 * Run:
 *   cd /tmp/wf-e2e && node /home/vivo/Notes/.pi/extensions/pi-workflow/e2e-toy.mjs
 * (directory needs node_modules/jiti — see spike history)
 */

import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ---- sandbox git repo ----
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-"));
process.chdir(sandbox);
execSync("git init -q && git config user.email test@test.com && git config user.name Test", { stdio: "pipe" });
console.log("sandbox:", sandbox);

// ---- stub module files ----
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

// ---- mock ExtensionAPI ----
const tools = new Map();
const hooks = new Map();
const api = {
	registerTool(t) { tools.set(t.name, t); },
	on(event, fn) { hooks.set(event, fn); },
};

// ---- load extension ----
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-ai": path.join(sandbox, "__stub_pi_ai.mjs"),
		"@earendil-works/pi-coding-agent": path.join(sandbox, "__stub_pi_agent.mjs"),
	},
});
const extModule = await jiti.import("/home/vivo/Notes/.pi/extensions/pi-workflow/index.ts");
const factory = extModule.default || extModule;
factory(api);
console.log("tools registered:", [...tools.keys()].join(", "));

// ---- helpers ----
let failures = 0;
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
	if (r?.block) console.log(`  hook BLOCK ${toolName} ${input.path ?? ""}: ${r.reason.slice(0, 80)}`);
	else console.log(`  hook PASS  ${toolName} ${input.path ?? ""}`);
	return r;
}
function assert(cond, msg) {
	if (!cond) { console.error(`  ✗ FAIL: ${msg}`); failures++; process.exitCode = 1; }
	else        { console.log(`  ✓ ${msg}`); }
}
function gitCommit(msg) {
	execSync(`git add -A && git commit -m "${msg}" --allow-empty`, { stdio: "pipe" });
	return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
}
function setRole(r) { process.env.PI_WORKFLOW_ROLE = r; }

// =========================================================
//  STAGE 0 — DIRECTOR INIT
// =========================================================
console.log("\n=== DIRECTOR: wf_init ===");
setRole("director");
await call("wf_init");
assert(fs.existsSync(".workflow/default/state.json"), "state.json exists");
// initial commit so SHA is always reachable
const initSha = gitCommit("chore: init workflow");
console.log("  init SHA:", initSha.slice(0, 7));

// =========================================================
//  STAGE 1+2 — PLANNING ∥ RESEARCH  (parallel)
// =========================================================
console.log("\n=== DIRECTOR: start planning + research (parallel) ===");
setRole("director");
await call("wf_stage_start", { stage: "planning" });
// Note: wf_stage_start only sets one stage at a time; we set research to in-progress
// via a second call after tweaking sequencing — but the extension checks prev=done,
// so we start planning first, then research (allowed because research idx=1, prev=planning not done yet,
// BUT the spec special-cases planning∥research). We handle this by directly setting research state too.
// In a real run the director would call wf_stage_start for each peer in sequence of assignment,
// but the extension only enforces the NEXT stage gate on wf_stage_start, not a "must be current" rule.
// So we call wf_stage_start research — it checks prev(research)=planning done → not done → normally blocked.
// The real workflow uses manual peer sessions; both see the same git repo.
// For the toy script, we simulate by: planner writes + commits, THEN scout writes + commits, THEN director calls task-breakdown.

// ---- PLANNER ----
console.log("\n--- PLANNER: planning stage ---");
setRole("planner");
// Verify planner can write .workflow/default/artifacts/plan.md (hook allows)
let h = await hook("write", { path: ".workflow/default/artifacts/plan.md" });
assert(!h?.block, "planner may write .workflow/default/artifacts/plan.md");

fs.writeFileSync(".workflow/default/artifacts/plan.md", `# plan

## goal
Add a \`GET /health\` endpoint that returns \`{"status":"ok","ts":<unix-ms>}\`.

## scope
- Add health handler to existing Express app
- Register route in app.ts
- No auth required

## non-goals
- Database liveness check (out of scope)
- Kubernetes readiness probe wiring (separate ticket)

## milestones
1. Route registered → 200 response with correct JSON
2. Tests green
3. Changelog updated

## complexity
XS — one file change + one test.
`);

fs.writeFileSync(".workflow/default/artifacts/tasks.md", `# tasks

| ID | Task | Acceptance criteria | Deps |
|----|------|---------------------|------|
| T1 | Add health handler | \`GET /health\` returns 200 \`{"status":"ok","ts":<number>}\` | — |
| T2 | Register route | route accessible at \`/health\` in running server | T1 |
| T3 | Unit test | jest test asserts 200 + body shape | T1, T2 |
`);

const planningSha = gitCommit("planning: add health endpoint plan + tasks");
console.log("  planning SHA:", planningSha.slice(0, 7));

// ---- SCOUT ----
console.log("\n--- SCOUT: research stage ---");
setRole("scout");
h = await hook("write", { path: ".workflow/default/artifacts/research.md" });
assert(!h?.block, "scout may write .workflow/default/artifacts/research.md");

fs.writeFileSync(".workflow/default/artifacts/research.md", `# research

## risks
- R1: Express version in package.json may not be installed — check before writing handler
- R2: Existing middleware order might shadow /health (e.g. auth guard mounted at root)

## dependencies
- express@4.x — used at src/app.ts
- none-added (health endpoint needs no new deps)

## reusable components
- \`src/app.ts:createApp()\` — mounts all routes; health handler should be added here
- \`src/middleware/logger.ts:requestLogger\` — already logs all routes, no extra wiring needed
`);

const researchSha = gitCommit("research: health endpoint risks + reusables");
console.log("  research SHA:", researchSha.slice(0, 7));

// =========================================================
//  STAGE 3 — TASK-BREAKDOWN (director synthesis)
// =========================================================
console.log("\n=== DIRECTOR: task-breakdown ===");
setRole("director");

// Now both planning and research are done (committed), director calls wf_stage_complete on both
// then wf_stage_start task-breakdown. Extension requires prev stage done.
// We complete planning first (it was started), then research (start+complete together).
let rc = await call("wf_stage_complete", { stage: "planning", sha: planningSha });
assert(rc.details.ok === true, "planning APPROVED");

// Start research explicitly (extension checks planning done → ok now)
rc = await call("wf_stage_start", { stage: "research" });
assert(rc.details.ok === true, "research stage started");
rc = await call("wf_stage_complete", { stage: "research", sha: researchSha });
assert(rc.details.ok === true, "research APPROVED");

// Now task-breakdown
rc = await call("wf_stage_start", { stage: "task-breakdown" });
assert(rc.details.ok === true, "task-breakdown started");

// Director reconciles plan.md + research.md → updates tasks.md
setRole("director");
h = await hook("write", { path: ".workflow/default/artifacts/tasks.md" });
assert(!h?.block, "director may write tasks.md");

fs.writeFileSync(".workflow/default/artifacts/tasks.md", `# tasks (reconciled)

| ID | Task | Acceptance criteria | Deps | Notes |
|----|------|---------------------|------|-------|
| T1 | Add health handler | \`GET /health\` → 200 \`{"status":"ok","ts":<number>}\` | — | Use Date.now() |
| T2 | Register route before auth middleware | route accessible without token | T1 | R2: mount before auth guard |
| T3 | Unit test | jest asserts 200 + body shape + ts is number | T1, T2 | |
`);

// Director logs reconciliation decision
h = await hook("write", { path: ".workflow/default/artifacts/decisions.md" });
assert(!h?.block, "director may write decisions.md");
fs.appendFileSync(".workflow/default/artifacts/decisions.md", `
## task-breakdown reconciliation
- T2: R2 (auth guard at root) → register /health before auth middleware mount point in createApp().
- T3: acceptance criteria from plan carried through unchanged.
`);

const tbSha = gitCommit("task-breakdown: reconcile tasks with research");
console.log("  task-breakdown SHA:", tbSha.slice(0, 7));
rc = await call("wf_stage_complete", { stage: "task-breakdown", sha: tbSha });
assert(rc.details.ok === true, "task-breakdown APPROVED");

// =========================================================
//  STAGE 4 — ARCHITECTURE
// =========================================================
console.log("\n=== ARCHITECT: architecture stage ===");
setRole("director");
rc = await call("wf_stage_start", { stage: "architecture" });
assert(rc.details.ok === true, "architecture started");

setRole("architect");
h = await hook("write", { path: ".workflow/default/artifacts/architecture.md" });
assert(!h?.block, "architect may write .workflow/default/artifacts/architecture.md");

fs.writeFileSync(".workflow/default/artifacts/architecture.md", `# architecture

## components
- \`src/handlers/health.ts\` — new file, exports \`healthHandler\`
- \`src/app.ts\` — registers route; one-line change

## interfaces

\`\`\`ts
// src/handlers/health.ts
export function healthHandler(_req: Request, res: Response): void {
  res.json({ status: "ok", ts: Date.now() });
}
\`\`\`

## data flow
\`GET /health\` → Express router → \`healthHandler\` → JSON response (no DB, no auth)

## trade-offs (T2)
Mount route before auth middleware. Avoids token check on health probes.
Alternative: separate unauthenticated router — rejected (overkill for one route).
`);

// Architect appends to decisions.md
h = await hook("write", { path: ".workflow/default/artifacts/decisions.md" });
assert(!h?.block, "architect may append decisions.md");
fs.appendFileSync(".workflow/default/artifacts/decisions.md", `
## design: /health before auth
Mount /health before auth guard. Auth guard currently in createApp() at line ~30.
Alternative (separate unauth router) rejected — too heavy for one route.
`);

const archSha = gitCommit("architecture: health endpoint design");
console.log("  architecture SHA:", archSha.slice(0, 7));
setRole("director");
rc = await call("wf_stage_complete", { stage: "architecture", sha: archSha });
assert(rc.details.ok === true, "architecture APPROVED");

// =========================================================
//  STAGE 5 — IMPLEMENTATION
// =========================================================
console.log("\n=== ENGINEER: implementation stage ===");
setRole("director");
rc = await call("wf_stage_start", { stage: "implementation" });
assert(rc.details.ok === true, "implementation started");

setRole("engineer");
// Engineer writes source files (not artifact .md)
h = await hook("write", { path: "src/handlers/health.ts" });
assert(!h?.block, "engineer may write source");
h = await hook("write", { path: ".workflow/default/artifacts/plan.md" });
assert(h?.block, "engineer BLOCKED from plan.md");

fs.mkdirSync("src/handlers", { recursive: true });
fs.writeFileSync("src/handlers/health.ts", `import { Request, Response } from "express";

export function healthHandler(_req: Request, res: Response): void {
  res.json({ status: "ok", ts: Date.now() });
}
`);

fs.writeFileSync("src/app.ts", `import express from "express";
import { healthHandler } from "./handlers/health";

export function createApp() {
  const app = express();

  // Health — registered before auth middleware (T2, arch decision)
  app.get("/health", healthHandler);

  // ... auth middleware would be mounted here ...

  return app;
}
`);

const implSha = gitCommit("impl(T1,T2): add health handler and register route");
console.log("  impl SHA:", implSha.slice(0, 7));
setRole("director");
rc = await call("wf_stage_complete", { stage: "implementation", sha: implSha });
assert(rc.details.ok === true, "implementation APPROVED");

// =========================================================
//  STAGE 6 — REVIEW
// =========================================================
console.log("\n=== REVIEWER: review stage ===");
setRole("director");
rc = await call("wf_stage_start", { stage: "review" });
assert(rc.details.ok === true, "review started");

setRole("reviewer");
h = await hook("write", { path: ".workflow/default/artifacts/review.md" });
assert(!h?.block, "reviewer may write .workflow/default/artifacts/review.md");

fs.writeFileSync(".workflow/default/artifacts/review.md", `# review

## verdict: APPROVED

## findings
- healthHandler correctly returns \`{status,ts}\` shape (T1 ✓)
- Route mounted before auth middleware line in createApp (T2 ✓)
- No hardcoded strings; Date.now() used (correct)

## minor notes (non-blocking)
- Consider extracting \`{ status: "ok" as const }\` type for future TypeScript strictness
- No issues blocking merge.

## QA handoff
All three tasks covered by acceptance criteria. QA should run T3 test suite.
`);

const reviewSha = gitCommit("review: health endpoint approved");
console.log("  review SHA:", reviewSha.slice(0, 7));
setRole("director");
rc = await call("wf_stage_complete", { stage: "review", sha: reviewSha });
assert(rc.details.ok === true, "review APPROVED");

// =========================================================
//  STAGE 7 — TESTING
// =========================================================
console.log("\n=== QA: testing stage ===");
setRole("director");
rc = await call("wf_stage_start", { stage: "testing" });
assert(rc.details.ok === true, "testing started");

setRole("qa");
h = await hook("write", { path: ".workflow/default/artifacts/test-report.md" });
assert(!h?.block, "qa may write .workflow/default/artifacts/test-report.md");
h = await hook("write", { path: "tests/health.test.ts" });
assert(!h?.block, "qa may write test files");

fs.mkdirSync("tests", { recursive: true });
fs.writeFileSync("tests/health.test.ts", `import request from "supertest";
import { createApp } from "../src/app";

describe("GET /health", () => {
  const app = createApp();
  it("returns 200 with status=ok and numeric ts", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.ts).toBe("number");
  });
});
`);

fs.writeFileSync(".workflow/default/artifacts/test-report.md", `# test-report

## result: PASS

| Test | Result |
|------|--------|
| GET /health → 200 | ✓ PASS |
| body.status === "ok" | ✓ PASS |
| body.ts is number | ✓ PASS |

## coverage
- T3 acceptance criteria fully verified
- No regressions (no other routes affected)
`);

const testSha = gitCommit("testing: health endpoint test suite — all pass");
console.log("  test SHA:", testSha.slice(0, 7));
setRole("director");
rc = await call("wf_stage_complete", { stage: "testing", sha: testSha });
assert(rc.details.ok === true, "testing APPROVED");

// =========================================================
//  STAGE 8 — DOCUMENTATION
// =========================================================
console.log("\n=== DOCUMENTER: documentation stage ===");
setRole("director");
rc = await call("wf_stage_start", { stage: "documentation" });
assert(rc.details.ok === true, "documentation started");

setRole("documenter");
h = await hook("write", { path: ".workflow/default/artifacts/changelog.md" });
assert(!h?.block, "documenter may write .workflow/default/artifacts/changelog.md");

fs.writeFileSync(".workflow/default/artifacts/changelog.md", `# changelog

## [unreleased]

### added
- \`GET /health\` endpoint returns \`{"status":"ok","ts":<unix-ms>}\`
  - Mounted before auth middleware — no token required for health probes
  - Covered by jest test suite (T3)
`);

const docSha = gitCommit("documentation: changelog for health endpoint");
console.log("  doc SHA:", docSha.slice(0, 7));
setRole("director");
rc = await call("wf_stage_complete", { stage: "documentation", sha: docSha });
assert(rc.details.ok === true, "documentation APPROVED");

// =========================================================
//  FINAL VALIDATION
// =========================================================
console.log("\n=== FINAL VALIDATION ===");
setRole("director");
const status = await call("wf_status");
const statusText = status.content[0].text;
console.log(statusText);

// All 8 stages must be "done" in state.json
const state = JSON.parse(fs.readFileSync(".workflow/default/state.json", "utf8"));
const stageNames = ["planning", "research", "task-breakdown", "architecture", "implementation", "review", "testing", "documentation"];
for (const s of stageNames) {
	assert(state.stages[s].status === "done", `stage ${s} = done`);
}

// No open CLRs
const clr = JSON.parse(fs.readFileSync(".workflow/default/clr-index.json", "utf8"));
assert(clr.open.length === 0, "no open CLRs");

// All required artifacts committed and non-stub — now in .workflow/default/artifacts/
for (const art of ["plan.md", "tasks.md", "research.md", "architecture.md", "review.md", "test-report.md", "changelog.md"]) {
	const content = fs.readFileSync(`.workflow/default/artifacts/${art}`, "utf8");
	assert(!content.includes("_empty_"), `${art} is not a stub`);
}

// Source files exist
assert(fs.existsSync("src/handlers/health.ts"), "src/handlers/health.ts exists");
assert(fs.existsSync("src/app.ts"), "src/app.ts exists");
assert(fs.existsSync("tests/health.test.ts"), "tests/health.test.ts exists");

console.log("\n=== git log ===");
console.log(execSync("git log --oneline", { encoding: "utf8" }));

if (failures === 0) {
	console.log("✓ ALL ASSERTIONS PASSED — toy end-to-end run complete");
} else {
	console.error(`✗ ${failures} assertion(s) FAILED`);
}
