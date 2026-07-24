/**
 * pi-workflow — viability spike
 *
 * Proves three hard parts at once:
 *   1. Custom stateful tools (wf_*) with disk-backed state under .workflow/
 *   2. Role-based path allowlist that hard-blocks write/edit
 *   3. CLR gate that hard-blocks write/edit while any OPEN CLR names current or upstream stage
 *
 * Role is read from env PI_WORKFLOW_ROLE. Two independent defaults:
 *   - Tool-body permission checks (e.g. "director only") default to "director" when unset —
 *     see role().
 *   - The write/edit gate in the tool_call hook does NOT default at all: when
 *     PI_WORKFLOW_ROLE is unset, roleOrNull() is null and the hook exits immediately,
 *     meaning writes are completely ungated (not even director-restricted). Only set
 *     PI_WORKFLOW_ROLE for sessions that should actually be gated.
 * State: .workflow/<id>/state.json, .workflow/<id>/clr-index.json
 * Artifacts (per-workflow, .workflow/<id>/artifacts/): plan.md, tasks.md, research.md,
 *            decisions.md, clarifications.md, progress.md, review.md, test-report.md, changelog.md
 * Shared artifact (.workflow/shared/artifacts/, one copy for the whole repo across all
 *            parallel workflow ids — architecture is a codebase property, not a task property):
 *            architecture.md
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---- constants ----

const STAGES = [
	"planning",
	"research",
	"task-breakdown",
	"architecture",
	"implementation",
	"review",
	"testing",
	"documentation",
] as const;
type Stage = (typeof STAGES)[number];

const ARTIFACT_FOR_STAGE: Record<Stage, string[]> = {
	planning: ["plan.md", "tasks.md"],
	research: ["research.md", "context.md"],
	"task-breakdown": ["tasks.md", "context.md"], // director may edit
	architecture: ["architecture.md", "context.md"],
	implementation: ["context.md"], // source code + context
	review: ["review.md", "context.md"],
	testing: ["test-report.md", "context.md"],
	documentation: ["changelog.md", "context.md"],
};

// Maps each stage to the role that should execute it.
// Used by wf_stage_start to advise the director which role to delegate to.
const ROLE_FOR_STAGE: Record<Stage, string> = {
	planning: "planner",
	research: "scout",
	"task-breakdown": "planner",
	architecture: "architect",
	implementation: "engineer",
	review: "reviewer",
	testing: "qa",
	documentation: "documenter",
};

// Which paths each role may write/edit. Empty = source code allowed, artifacts denied.
const ROLE_ALLOW: Record<string, RegExp[]> = {
	// NOTE: patterns are matched against the path *inside* the current session's
// .workflow/<id>/ namespace (prefix already stripped) — see isPathAllowedForRole.
director: [/^.*$/], // director may write any state file within its own namespace
	planner: [/^artifacts\/plan\.md$/, /^artifacts\/tasks\.md$/, /^artifacts\/context\.md$/, /^artifacts\/clarifications\.md$/],
	scout: [/^artifacts\/research\.md$/, /^artifacts\/context\.md$/, /^artifacts\/clarifications\.md$/],
	architect: [/^artifacts\/architecture\.md$/, /^artifacts\/decisions\.md$/, /^artifacts\/context\.md$/, /^artifacts\/clarifications\.md$/],
	engineer: [/^artifacts\/context\.md$/, /^artifacts\/clarifications\.md$/], // + source (default allow below)
	reviewer: [/^artifacts\/review\.md$/, /^artifacts\/context\.md$/, /^artifacts\/clarifications\.md$/],
	qa: [/^artifacts\/test-report\.md$/, /^artifacts\/context\.md$/, /^artifacts\/clarifications\.md$/, /(^|\/)tests?\//, /\.test\./, /\.spec\./],
	documenter: [/^artifacts\/changelog\.md$/, /^artifacts\/context\.md$/, /^docs\//, /^README\.md$/, /^artifacts\/clarifications\.md$/],
};

// Artifact md files. Anything not in this set is treated as "source" and allowed for engineer.
// NOTE: progress.md is deliberately excluded — it's auto-rendered by saveState() straight to
// .workflow/<id>/progress.md (not artifacts/), so it must never be stubbed or hand-edited.
const ARTIFACT_MDS = new Set([
	"plan.md",
	"tasks.md",
	"research.md",
	"architecture.md",
	"decisions.md",
	"clarifications.md",
	"review.md",
	"test-report.md",
	"changelog.md",
	"context.md", // shared knowledge cache between agents
]);

// Artifacts that live at .workflow/shared/artifacts/ instead of per-workflow.
// These are properties of the codebase, not of an individual task.
const SHARED_ARTIFACTS = new Set(["architecture.md"]);

// ---- state ----

interface RetryRec {
	bumps: number; // failed attempts since last ruling
	ruled: number; // director rulings issued on this key
}
interface WfState {
	stages: Record<Stage, { status: "todo" | "in-progress" | "done" | "blocked" | "retry" | "failed"; sha?: string; retries?: number }>;
	current: Stage | null;
	rulings: Record<string, RetryRec>; // CLR-id or defect-key → counters
}

interface ClrIndex {
	open: { id: string; stage: string; raisedBy: string }[];
}

// ---- helpers ----

function repoRoot(): string {
	return process.cwd();
}
// Unique id for this session, stable for the lifetime of the extension process.
// Each parallel pi *director* gets its own process → its own .workflow/<id>/ namespace,
// so multiple independent workflows can run concurrently in the same repo.
//
// Resolution order:
//   1. PI_WORKFLOW_ID env var — explicit override. REQUIRED if you want to run more than
//      one director concurrently in the same repo (see marker caveat below).
//   2. Director role, no env var → mint a fresh random id and publish it to
//      .workflow/.active-id, so this director's own subagents can find it (step 3).
//      Never *read* the marker as a director — doing so would collapse two independently
//      launched directors onto the same workflow id/lock and falsely BLOCK the second one.
//   3. Non-director role (subagent), no env var → read .workflow/.active-id. The
//      `subagent` tool has no env passthrough — a PI_WORKFLOW_ID=xxx prefix in the task
//      *text* does NOT set process.env in the spawned process — so this is how a subagent
//      lands in the SAME namespace as the director that spawned it, without needing the
//      text convention to actually work.
//
// Caveat: the marker is a single global "last active director" pointer, not per-director
// storage. It converges subagents correctly for the common case (one workflow active at a
// time). If you deliberately run two directors concurrently in the same repo, set
// PI_WORKFLOW_ID explicitly for each and pass it through to their subagents' task text
// (step 1) — the marker alone cannot disambiguate which subagent belongs to which
// concurrent director.
const SESSION_ID: string = (() => {
	if (process.env.PI_WORKFLOW_ID) {
		const safe = process.env.PI_WORKFLOW_ID.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
		if (safe) return safe;
	}
	const markerPath = path.join(process.cwd(), ".workflow", ".active-id");
	const isDirector = (process.env.PI_WORKFLOW_ROLE ?? "director").toLowerCase() === "director";
	if (!isDirector) {
		try {
			const existing = fs.readFileSync(markerPath, "utf8").trim();
			if (existing) return existing;
		} catch {
			// no marker yet (subagent spawned before any director ran here) — mint our own below
		}
	}
	const fresh = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
	if (isDirector) {
		try {
			fs.mkdirSync(path.dirname(markerPath), { recursive: true });
			fs.writeFileSync(markerPath, fresh);
		} catch {
			// best-effort; if we can't persist it, subagents just won't converge
		}
	}
	return fresh;
})();
function workflowId(): string {
	return SESSION_ID;
}
function wfRoot(): string {
	return path.join(repoRoot(), ".workflow");
}
function wfDir(): string {
	return path.join(wfRoot(), workflowId());
}
function artifactsDir(): string {
	return path.join(wfDir(), "artifacts");
}
function sharedArtifactsDir(): string {
	return path.join(wfRoot(), "shared", "artifacts");
}
/** Resolve the actual path for an artifact, routing shared ones to .workflow/shared/artifacts/. */
function artifactPath(filename: string): string {
	return SHARED_ARTIFACTS.has(filename)
		? path.join(sharedArtifactsDir(), filename)
		: path.join(artifactsDir(), filename);
}
function statePath(): string {
	return path.join(wfDir(), "state.json");
}
function clrIndexPath(): string {
	return path.join(wfDir(), "clr-index.json");
}
function lockPath(): string {
	return path.join(wfDir(), "director.lock");
}
// Returns null when PI_WORKFLOW_ROLE is unset — meaning this session is not
// participating in the workflow at all, so no role gating should apply.
// Only an explicit PI_WORKFLOW_ROLE=director makes a session the director.
function roleOrNull(): string | null {
	const v = process.env.PI_WORKFLOW_ROLE;
	return v ? v.toLowerCase() : null;
}
function role(): string {
	return roleOrNull() ?? "director";
}
function readJson<T>(p: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8")) as T;
	} catch {
		return fallback;
	}
}
function writeJson(p: string, obj: unknown): void {
	// Atomic write: write to a temp file then rename, so a kill mid-write
	// can never leave a half-written / corrupt state.json or clr-index.json.
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
	fs.renameSync(tmp, p);
}

// ---- concurrency lock ----
// Detects "is a workflow already running in this dir" via PID liveness.
// Self-heals: if the PID that holds the lock is dead (session was killed /
// quit), the lock is considered stale and silently reclaimed — no manual
// unlock step needed after an abort.

interface LockInfo {
	pid: number;
	host: string;
	startedAt: string;
	heartbeatAt: string;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLock(): LockInfo | null {
	return readJson<LockInfo | null>(lockPath(), null);
}

/** Returns null if lock acquired (or refreshed as our own), or the foreign
 *  LockInfo if another live process already holds it. */
function acquireOrCheckLock(): LockInfo | null {
	const existing = readLock();
	if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
		return existing; // foreign + alive → caller must not proceed
	}
	const info: LockInfo = {
		pid: process.pid,
		host: os.hostname(),
		startedAt: existing && existing.pid === process.pid ? existing.startedAt : new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
	};
	writeJson(lockPath(), info);
	return null;
}
function loadState(): WfState {
	const empty: WfState = {
		stages: Object.fromEntries(STAGES.map((s) => [s, { status: "todo" }])) as WfState["stages"],
		current: null,
		rulings: {},
	};
	return readJson(statePath(), empty);
}
function loadClr(): ClrIndex {
	return readJson(clrIndexPath(), { open: [] });
}
function relFromRepo(p: string): string {
	const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot(), p);
	return path.relative(repoRoot(), abs).replaceAll("\\", "/");
}
function stageIndex(s: string): number {
	return STAGES.indexOf(s as Stage);
}

// Stages to auto-skip by default, via PI_WORKFLOW_SKIP_STAGES="review,testing,documentation".
// wf_stage_start chains through them automatically; wf_stage_complete waives their
// artifact requirement too.
function skipStagesSet(): Set<Stage> {
	const raw = process.env.PI_WORKFLOW_SKIP_STAGES ?? "";
	const names = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	return new Set(names.filter((n): n is Stage => (STAGES as readonly string[]).includes(n)));
}

// ---- progress.md renderer ----

const SYMBOL: Record<string, string> = {
	todo: "⬜",
	"in-progress": "⏳",
	done: "✅",
	blocked: "🔴",
	retry: "🔁",
	failed: "❌",
};

function renderProgress(state: WfState): string {
	const rows = STAGES.map((s) => {
		const st = state.stages[s];
		const sym = SYMBOL[st.status] || "?";
		const sha = st.sha ? ` \`${st.sha.slice(0, 7)}\`` : "";
		const retries = st.retries ? ` (${st.retries}/3)` : "";
		return `| ${sym} | ${s}${retries}${sha} |`;
	}).join("\n");
	return `# progress\n\n| status | stage |\n|---|---|\n${rows}\n\n_current: ${state.current ?? "—"}_\n`;
}

function saveState(state: WfState): void {
	writeJson(statePath(), state);
	fs.writeFileSync(path.join(wfDir(), "progress.md"), renderProgress(state));
}

// ---- gating logic ----

// Returns the path relative to the relevant .workflow/ namespace:
//   "own"    — this session's .workflow/<id>/... (foreign=false)
//   "shared" — .workflow/shared/... (codebase-level artifacts like architecture.md,
//              reachable and non-foreign for every workflow id)
//   foreign  — a *different* workflow id's namespace — cross-namespace writes always denied.
function wfNamespaceRel(relPath: string): { inside: false } | { inside: true; kind: "own" | "foreign" | "shared"; inner: string } {
	if (!relPath.startsWith(".workflow/")) return { inside: false };
	const rest = relPath.slice(".workflow/".length); // "<id>/..." or "shared/..." or bare (legacy)
	const slash = rest.indexOf("/");
	if (slash === -1) return { inside: true, kind: "own", inner: rest }; // e.g. .workflow/director.lock (legacy, treat as own)
	const id = rest.slice(0, slash);
	const inner = rest.slice(slash + 1);
	if (id === "shared") return { inside: true, kind: "shared", inner };
	return { inside: true, kind: id === workflowId() ? "own" : "foreign", inner };
}

function isPathAllowedForRole(r: string, relPath: string): { ok: boolean; reason?: string } {
	const allow = ROLE_ALLOW[r];
	if (!allow) return { ok: false, reason: `unknown role "${r}"` };

	const ns = wfNamespaceRel(relPath);
	if (ns.inside) {
		// Cross-namespace: never allowed, regardless of role. Keeps concurrent
		// workflows (different PI_WORKFLOW_ID in the same repo) isolated.
		if (ns.kind === "foreign") {
			return { ok: false, reason: `path belongs to a different workflow namespace than PI_WORKFLOW_ID=${workflowId()}` };
		}

		// .workflow/shared/artifacts/ — codebase-level artifacts (architecture.md), reachable
		// from every workflow id. Only artifacts on the SHARED_ARTIFACTS list may live here,
		// and role allowlist still applies (architect/director may write architecture.md).
		if (ns.kind === "shared") {
			const isArtifact = ns.inner.startsWith("artifacts/");
			const filename = ns.inner.slice("artifacts/".length);
			if (!isArtifact || !SHARED_ARTIFACTS.has(filename)) {
				return { ok: false, reason: `.workflow/shared/ only holds shared artifacts (${[...SHARED_ARTIFACTS].join(", ")})` };
			}
			const match = allow.some((re) => re.test(ns.inner));
			return match
				? { ok: true }
				: { ok: false, reason: `${r} not permitted to write ${relPath}` };
		}

		// Non-artifact state files (state.json, clr-index.json, director.lock, progress.md): director only.
		const isArtifact = ns.inner.startsWith("artifacts/");
		if (!isArtifact) {
			return r === "director" ? { ok: true } : { ok: false, reason: `only director may write .workflow/${workflowId()}/ state files` };
		}

		// Artifact: must match role allowlist (patterns matched against the inner path, e.g. "artifacts/plan.md").
		const match = allow.some((re) => re.test(ns.inner));
		return match
			? { ok: true }
			: { ok: false, reason: `${r} not permitted to write ${relPath}` };
	}

	// Non-artifact source: engineer + qa (for test files) + documenter allowed by default.
	if (r === "engineer" || r === "qa" || r === "documenter") return { ok: true };
	// Others may not touch source.
	// Give a helpful hint if the filename looks like a misplaced artifact.
	const basename = relPath.split("/").pop() || relPath;
	const hintDir = SHARED_ARTIFACTS.has(basename) ? "shared" : workflowId();
	const hint = basename === "progress.md"
		? ` (progress.md is auto-generated at .workflow/${workflowId()}/progress.md — do not write it manually)`
		: ARTIFACT_MDS.has(basename) ? ` (did you mean .workflow/${hintDir}/artifacts/${basename}?)` : "";
	return { ok: false, reason: `${r} may not modify source (${relPath})${hint}` };
}

function clrBlocksStage(clr: ClrIndex, currentStage: Stage | null): { blocked: boolean; ids: string[] } {
	if (!currentStage) return { blocked: false, ids: [] };
	const curIdx = stageIndex(currentStage);
	const hits = clr.open.filter((c) => {
		const idx = stageIndex(c.stage);
		return idx === -1 ? false : idx <= curIdx;
	});
	return { blocked: hits.length > 0, ids: hits.map((c) => c.id) };
}

// ---- extension ----

const TOOL_CAP = 50;
let toolCalls = 0;

/** Reset tool counter — called when a new stage starts so each stage
 *  gets its own budget instead of sharing one across the entire session. */
function resetToolCalls(): void {
	toolCalls = 0;
}

export default function (pi: ExtensionAPI) {
	// Reset tool counter on session start / switch / reload
	pi.on("session_start", async (_event, _ctx) => {
		resetToolCalls();
	});

	// --- tool_call hook: 50-call ceiling + role + CLR gate ---
	pi.on("tool_call", async (event, _ctx) => {
		// No PI_WORKFLOW_ROLE set at all → this session isn't part of a
		// workflow run. Don't limit tool calls or gate writes.
		const r0 = roleOrNull();
		if (r0 === null) return undefined;

		toolCalls += 1;

		// 50-tool ceiling. Above cap, only allow write/edit so the agent can
		// mark its artifact `DRAFT — incomplete, split required` and stop.
		if (toolCalls > TOOL_CAP) {
			if (event.toolName !== "write" && event.toolName !== "edit") {
				return {
					block: true,
					reason: `pi-workflow: session hit ${TOOL_CAP}-tool ceiling (call ${toolCalls}). Mark your artifact \`DRAFT — incomplete, split required\`, propose sub-tasks, notify Director via wf_clr_open or intercom, then stop.`,
				};
			}
			if (toolCalls > TOOL_CAP + 5) {
				return { block: true, reason: `pi-workflow: hard stop at ${toolCalls} tool calls. Director must reassign.` };
			}
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const p = (event.input as { path?: string }).path;
		if (!p) return undefined;
		const rel = relFromRepo(p);

		// Skip files outside repo root — not our business.
		if (rel.startsWith("..")) return undefined;

		const r = r0;

		// 1. Role allowlist
		const allow = isPathAllowedForRole(r, rel);
		if (!allow.ok) {
			return { block: true, reason: `pi-workflow: ${allow.reason}` };
		}

		// 2. CLR gate — exempt .workflow/<id>/ state files and clarifications.md; artifacts still gated.
		const ns = wfNamespaceRel(rel);
		const isWfState = ns.inside && ns.kind === "own" && !ns.inner.startsWith("artifacts/");
		const isClarifications = ns.inside && ns.kind === "own" && ns.inner === "artifacts/clarifications.md";
		if (!isWfState && !isClarifications) {
			const state = loadState();
			const clr = loadClr();
			const gate = clrBlocksStage(clr, state.current);
			if (gate.blocked) {
				return {
					block: true,
					reason: `pi-workflow: OPEN CLR(s) block writes: ${gate.ids.join(", ")}. Resolve via wf_clr_resolve before editing.`,
				};
			}
		}

		return undefined;
	});

	// --- wf_init ---
	pi.registerTool({
		name: "wf_init",
		label: "wf_init",
		description: "Initialize .workflow/ state and stub artifacts. Director only.",
		parameters: Type.Object({}),
		async execute() {
			if (role() !== "director") {
				return { content: [{ type: "text", text: "denied: director only" }], details: { ok: false } };
			}
			fs.mkdirSync(artifactsDir(), { recursive: true });
			const gitignorePath = path.join(repoRoot(), ".gitignore");
			if (fs.existsSync(gitignorePath)) {
				const gitignore = fs.readFileSync(gitignorePath, "utf8");
				if (!gitignore.includes(".workflow/")) fs.appendFileSync(gitignorePath, "\n.workflow/\n");
				
			} else {
				fs.writeFileSync(gitignorePath, ".workflow/\n");
			}
			const foreign = acquireOrCheckLock();
			if (foreign) {
				return {
					content: [{
						type: "text",
						text: `BLOCKED: another director session is already running workflow "${workflowId()}" (pid ${foreign.pid} on ${foreign.host}, started ${foreign.startedAt}, last heartbeat ${foreign.heartbeatAt}). ` +
							`If that session is dead, it will self-clear next time this is called. To work on a second feature in parallel in this same repo, set a distinct PI_WORKFLOW_ID (e.g. PI_WORKFLOW_ID=notifications) before calling wf_init — each id gets its own isolated .workflow/<id>/ lock, state, and artifacts. Alternatively use a separate git worktree.`,
					}],
					details: { ok: false, decision: "LOCKED", lock: foreign },
				};
			}
			const state = loadState();
			saveState(state);
			writeJson(clrIndexPath(), loadClr());
			fs.mkdirSync(sharedArtifactsDir(), { recursive: true });
			for (const md of ARTIFACT_MDS) {
				const abs = artifactPath(md);
				if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${md.replace(".md", "")}\n\n_empty_\n`);
			}
			return { content: [{ type: "text", text: "workflow initialized" }], details: { ok: true } };
		},
	});

	// --- wf_stage_start ---
	pi.registerTool({
		name: "wf_stage_start",
		label: "wf_stage_start",
		description: "Set current stage to <stage>. Director only. Rejects if previous stage not done. Stages listed in PI_WORKFLOW_SKIP_STAGES (comma-separated) are auto-skipped and chained through.",
		parameters: Type.Object({ stage: StringEnum([...STAGES]) }),
		async execute(_id, params) {
			if (role() !== "director") return deny("director only");
			const state = loadState();
			const target = params.stage as Stage;
			const idx = stageIndex(target);
			if (idx > 0) {
				// task-breakdown runs after BOTH planning and research (they run in parallel);
				// every other stage just needs its immediate predecessor done.
				const prevOk = target === "task-breakdown"
					? state.stages.planning.status === "done" && state.stages.research.status === "done"
					: state.stages[STAGES[idx - 1]].status === "done";
				if (!prevOk) {
					const need = target === "task-breakdown" ? "planning and research" : STAGES[idx - 1];
					return deny(`previous stage(s) "${need}" not done`);
				}
			}
			// --- auto-skip chain: fast-forward through any configured skip stages ---
			fs.mkdirSync(artifactsDir(), { recursive: true }); // guard: ensure dir exists even if wf_init wasn't called first
			const skip = skipStagesSet();
			const skippedChain: Stage[] = [];
			let cur: Stage | null = target;
			while (cur && skip.has(cur)) {
				state.stages[cur].status = "done";
				state.stages[cur].sha = "auto-skip";
				skippedChain.push(cur);
				cur = nextStage(cur);
			}
			if (cur) {
				state.current = cur;
				state.stages[cur].status = "in-progress";
			} else {
				state.current = null;
			}
			saveState(state);
			if (skippedChain.length) {
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## auto-skip (PI_WORKFLOW_SKIP_STAGES)\n- Skipped: ${skippedChain.join(", ")}\n`,
				);
			}
			acquireOrCheckLock(); // refresh heartbeat; also self-reclaims a stale lock

			// Reset per-stage tool budget so each stage gets a fresh 50-call cap
			resetToolCalls();

			if (!cur) {
				return ok(`stage(s) skipped: ${skippedChain.join(", ")}. Workflow reached end — no stage in-progress.`);
			}

			// Delegation guidance: tell solo directors to spawn a subagent
			const delegateRole = ROLE_FOR_STAGE[cur];
			const artifacts = ARTIFACT_FOR_STAGE[cur];
			const artifactList = artifacts.length ? artifacts.join(", ") : "source code";
			const skippedNote = skippedChain.length ? ` (auto-skipped: ${skippedChain.join(", ")})` : "";
			const hint = [
				`\n\nDELEGATE: Spawn subagent with agent="${delegateRole}".`,
				`Task prompt must start with "PI_WORKFLOW_ROLE=${delegateRole} PI_WORKFLOW_ID=${workflowId()}" and load skill "wf-${delegateRole}".`,
				`(This id is also auto-shared via .workflow/.active-id, so the subagent lands in the same namespace even though this text is not an env var in its process — keep the prefix for role/readability.)`,
				`Each subagent gets a fresh context window and ${TOOL_CAP}-tool budget.`,
				`Expected artifacts: ${artifactList}`,
				`When finished, call wf_stage_complete("${cur}", sha).`,
			].join(" ");
			return ok(`stage started: ${cur}${skippedNote}${hint}`);
		},
	});

	// --- wf_stage_complete ---
	pi.registerTool({
		name: "wf_stage_complete",
		label: "wf_stage_complete",
		description: "Run transition checklist for <stage>. Director only. Requires a change marker (git SHA from `git rev-parse HEAD` if the project is a git repo; if not, omit `sha` and one is auto-generated). Blocks if OPEN CLR names this or upstream stage, or required artifact absent.",
		parameters: Type.Object({
			stage: StringEnum([...STAGES]),
			sha: Type.Optional(Type.String({ description: "git SHA from `git rev-parse HEAD`. Optional — if the project has no git repo, omit this and a placeholder marker is generated automatically." })),
			skip: Type.Optional(Type.String({ description: "trivial-task escape: skip this and remaining pre-implementation stages, reason logged to decisions.md" })),
		}),
		async execute(_id, params) {
			if (role() !== "director") return deny("director only");
			const state = loadState();
			const clr = loadClr();
			const stage = params.stage as Stage;
			const sha = params.sha ?? crypto.randomBytes(4).toString("hex");

			// --- trivial-task escape hatch ---
			if (params.skip) {
				const implIdx = stageIndex("implementation");
				const startIdx = stageIndex(stage);
				if (startIdx === -1 || startIdx >= implIdx) {
					return deny("skip only allowed on pre-implementation stages");
				}
				if (!/^[0-9a-f]{7,40}$/i.test(sha)) return deny(`bad sha: ${sha}`);
				const skipped: string[] = [];
				for (let i = startIdx; i < implIdx; i++) {
					const s = STAGES[i];
					state.stages[s].status = "done";
					state.stages[s].sha = sha;
					skipped.push(s);
				}
				state.current = "implementation";
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## trivial-task skip @ ${sha.slice(0, 7)}\n- Skipped: ${skipped.join(", ")}\n- Reason: ${params.skip}\n`,
				);
				return {
					content: [{ type: "text", text: `SKIPPED ${skipped.join(", ")} → implementation` }],
					details: { ok: true, decision: "SKIPPED", skipped, sha },
				};
			}

			const errors: string[] = [];

			// 1. artifact exists — waived for stages configured via PI_WORKFLOW_SKIP_STAGES
			const autoSkip = skipStagesSet().has(stage);
			for (const art of autoSkip ? [] : ARTIFACT_FOR_STAGE[stage]) {
				const abs = artifactPath(art);
				if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8").trim() === "" || fs.readFileSync(abs, "utf8").includes("_empty_")) {
					errors.push(`artifact missing or stub: ${art}`);
				}
			}

			// 2. CLR gate
			const gate = clrBlocksStage(clr, stage);
			if (gate.blocked) errors.push(`OPEN CLRs block: ${gate.ids.join(", ")}`);

			// 3. retry limit
			const retries = state.stages[stage].retries ?? 0;
			if (retries > 3) errors.push(`retry count ${retries} exceeds cap`);

			// 4. SHA sanity
			if (!/^[0-9a-f]{7,40}$/i.test(sha)) errors.push(`bad sha: ${sha}`);

			if (errors.length) {
				return {
					content: [{ type: "text", text: `BLOCKED\n- ${errors.join("\n- ")}` }],
					details: { ok: false, decision: "BLOCKED", errors },
				};
			}

			state.stages[stage].status = "done";
			state.stages[stage].sha = sha;
			state.current = nextStage(stage);
			saveState(state);
			return {
				content: [{ type: "text", text: `APPROVED ${stage} @ ${sha.slice(0, 7)}` }],
				details: { ok: true, decision: "APPROVED", stage, sha },
			};
		},
	});

	// --- wf_clr_open ---
	pi.registerTool({
		name: "wf_clr_open",
		label: "wf_clr_open",
		description: "File a clarification request. Halts caller. Any role.",
		parameters: Type.Object({
			stage: StringEnum([...STAGES]),
			question: Type.String(),
		}),
		async execute(_id, params) {
			const id = `CLR-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
			const clr = loadClr();
			clr.open.push({ id, stage: params.stage, raisedBy: role() });
			writeJson(clrIndexPath(), clr);
			const entry = `\n## ${id}\n- Status: OPEN\n- Raised by: ${role()}\n- Stage: ${params.stage}\n- Question: ${params.question}\n- Resolution: _pending_\n- Resolved by: _pending_\n`;
			const clrFile = path.join(artifactsDir(), "clarifications.md");
			fs.appendFileSync(clrFile, entry);
			// mark stage blocked
			const state = loadState();
			if (state.stages[params.stage as Stage]) {
				state.stages[params.stage as Stage].status = "blocked";
				saveState(state);
			}
			return { content: [{ type: "text", text: `HALT: filed ${id}. Stop current work.` }], details: { ok: true, id } };
		},
	});

	// --- wf_clr_resolve ---
	pi.registerTool({
		name: "wf_clr_resolve",
		label: "wf_clr_resolve",
		description: "Resolve a CLR. Director only for now.",
		parameters: Type.Object({ id: Type.String(), resolution: Type.String() }),
		async execute(_id, params) {
			if (role() !== "director") return deny("director only");
			const clr = loadClr();
			const before = clr.open.length;
			clr.open = clr.open.filter((c) => c.id !== params.id);
			if (clr.open.length === before) return deny(`no OPEN CLR with id ${params.id}`);
			writeJson(clrIndexPath(), clr);
			// append resolution note
			fs.appendFileSync(
				path.join(artifactsDir(), "clarifications.md"),
				`\n<!-- ${params.id} resolved by director: ${params.resolution} -->\n`,
			);
			return ok(`resolved ${params.id}`);
		},
	});

	// --- wf_retry_bump ---
	pi.registerTool({
		name: "wf_retry_bump",
		label: "wf_retry_bump",
		description: "Record a failed attempt for <key> (e.g. CLR id or defect slug). Returns OK, DIRECTOR_RULE at 3 bumps, or HUMAN if key already has 3 rulings. Same-bug key spans Review+QA loops.",
		parameters: Type.Object({ key: Type.String({ description: "stable defect / CLR key" }) }),
		async execute(_id, params) {
			const state = loadState();
			const rec = state.rulings[params.key] ?? { bumps: 0, ruled: 0 };
			if (rec.ruled >= 3) {
				return { content: [{ type: "text", text: `HUMAN: ${params.key} has ${rec.ruled} director rulings — escalate.` }], details: { ok: false, decision: "HUMAN", key: params.key, ...rec } };
			}
			rec.bumps += 1;
			state.rulings[params.key] = rec;
			// Mirror onto the current stage's retry counter so wf_stage_complete's retry-cap
			// check and the progress.md "(n/3)" annotation actually reflect real bumps.
			if (state.current) {
				state.stages[state.current].retries = (state.stages[state.current].retries ?? 0) + 1;
			}
			saveState(state);
			if (rec.bumps >= 3) {
				return { content: [{ type: "text", text: `DIRECTOR_RULE: ${params.key} at ${rec.bumps} bumps — director must rule via wf_retry_rule.` }], details: { ok: true, decision: "DIRECTOR_RULE", key: params.key, ...rec } };
			}
			return { content: [{ type: "text", text: `OK: ${params.key} bumps=${rec.bumps}` }], details: { ok: true, decision: "OK", key: params.key, ...rec } };
		},
	});

	// --- wf_retry_rule ---
	pi.registerTool({
		name: "wf_retry_rule",
		label: "wf_retry_rule",
		description: "Director ruling on a stuck retry key. Resets bumps, increments ruled count, logs to decisions.md. HUMAN escalation at 3 rulings.",
		parameters: Type.Object({ key: Type.String(), ruling: Type.String({ description: "the decision text" }) }),
		async execute(_id, params) {
			if (role() !== "director") return deny("director only");
			const state = loadState();
			const rec = state.rulings[params.key] ?? { bumps: 0, ruled: 0 };
			rec.ruled += 1;
			rec.bumps = 0;
			state.rulings[params.key] = rec;
			// A ruling resets the current stage's retry counter too, keeping it in sync with bumps.
			if (state.current) state.stages[state.current].retries = 0;
			saveState(state);
			fs.appendFileSync(
				path.join(artifactsDir(), "decisions.md"),
				`\n## ruling on ${params.key} (#${rec.ruled}/3)\n${params.ruling}\n`,
			);
			const esc = rec.ruled >= 3 ? " — next bump escalates to HUMAN" : "";
			return { content: [{ type: "text", text: `ruled ${params.key} (${rec.ruled}/3)${esc}` }], details: { ok: true, key: params.key, ...rec } };
		},
	});

	// --- wf_status ---
	pi.registerTool({
		name: "wf_status",
		label: "wf_status",
		description: "Dump workflow state, current stage, open CLRs. Any role.",
		parameters: Type.Object({}),
		async execute() {
			const state = loadState();
			const clr = loadClr();
			const lock = readLock();
			const lockLine = lock
				? `lock: pid ${lock.pid} on ${lock.host} (${isPidAlive(lock.pid) ? "ALIVE" : "STALE — will be reclaimed"}), heartbeat ${lock.heartbeatAt}`
				: "lock: none";
			const lines = [
				`role: ${role()}`,
				`workflow id: ${workflowId()}`,
				`current: ${state.current ?? "—"}`,
				`open CLRs: ${clr.open.length ? clr.open.map((c) => `${c.id}(${c.stage})`).join(", ") : "none"}`,
				lockLine,
				"",
				renderProgress(state),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { state, clr, lock } };
		},
	});
}

function nextStage(s: Stage): Stage | null {
	const i = stageIndex(s);
	return i < STAGES.length - 1 ? STAGES[i + 1] : null;
}
function ok(msg: string) {
	return { content: [{ type: "text", text: msg }], details: { ok: true } };
}
function deny(msg: string) {
	return { content: [{ type: "text", text: `denied: ${msg}` }], details: { ok: false, reason: msg } };
}
