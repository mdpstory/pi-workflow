/**
 * pi-workflow — role-enforced, stage-gated AI workflow extension.
 *
 * Role model (P0-2): three states, not two.
 *   - "unassigned": no PI_WORKFLOW_ROLE env, no in-process wf_claim() call. A casual,
 *     non-workflow session. No write gating. Only wf_status/wf_claim/wf_approve usable
 *     among wf_* tools.
 *   - "director": PI_WORKFLOW_ROLE=director env, OR wf_claim("director") called
 *     in-process (never persisted to disk, never inherited by children — loading skill
 *     wf-director calls wf_claim as step 0). Director's own write allowlist (ROLE_ALLOW.director)
 *     is now hard-enforced, same as every other role.
 *   - "<role>": PI_WORKFLOW_ROLE=<role> env — a dispatched subagent. Role allowlist +
 *     CLR gate enforced.
 * workflowActive() = role() !== "unassigned". Gating (write/edit hook, tool ceiling) only
 * activates once a role exists — including for the director itself.
 *
 * Workflow id (P0-3): PI_WORKFLOW_ID env > .workflow/.active-id marker (read+written by
 * every role, not director-only — makes "kill and restart" resume the same workflow) >
 * mint fresh + write marker. wf_new() mints an explicit new id (start workflow #2, not by
 * restarting a session). wf_list() enumerates all `.workflow/<id>/` namespaces.
 *
 * State: .workflow/<id>/state.json, .workflow/<id>/clr-index.json
 * Artifacts (per-workflow, .workflow/<id>/artifacts/): plan.md, tasks.md, research.md,
 *            decisions.md, clarifications.md, review.md, test-report.md, changelog.md
 * Shared artifact (.workflow/shared/artifacts/, one copy for the whole repo across all
 *            parallel workflow ids — architecture is a codebase property, not a task
 *            property): architecture.md
 * Knowledge (P1): per-source-file immutable fragments, .workflow/shared/knowledge/ or
 *            .workflow/<id>/knowledge/, see wf_knowledge_put/get.
 * Bus (P2): .workflow/<id>/bus/<role>.jsonl, see wf_msg_post/poll/wf_bus_digest.
 *
 * P1-2 (mechanical read interception): implemented via the `tool_result` hook (which CAN
 * substitute a tool's content — unlike `tool_call`, which is block-only). Opt-in through
 * config `interceptReads`. A full-file `read` of a source with fresh (mtime+size matching)
 * knowledge fragments returns the fragment(s) instead of the raw body; passing offset/limit
 * is the escape hatch for raw source. Off by default because it changes read semantics.
 * wf_knowledge_get remains the explicit path and works regardless of the flag.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { isReadToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installSubagentTool from "./subagent/tool.ts";

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
	research: ["research.md"],
	"task-breakdown": ["tasks.md"], // director may edit
	architecture: ["architecture.md"],
	implementation: [], // source code; knowledge fragments, not an artifact
	review: ["review.md"],
	testing: ["test-report.md"],
	documentation: ["changelog.md"],
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
	// Director's non-artifact state files (state.json, clr-index.json, director.lock) are
	// handled by a separate "director only" branch in isPathAllowedForRole and don't need a
	// pattern here. This list therefore only needs to cover the *artifacts* director is
	// actually allowed to write directly — must NOT be a wildcard, or director could write
	// plan.md/research.md/review.md/test-report.md/changelog.md, which are supposed to be
	// hard-blocked (owned by Planner/Scout/Reviewer/QA/Documenter respectively).
	director: [/^artifacts\/decisions\.md$/, /^artifacts\/tasks\.md$/, /^artifacts\/clarifications\.md$/],
	planner: [/^artifacts\/plan\.md$/, /^artifacts\/tasks\.md$/, /^artifacts\/clarifications\.md$/],
	scout: [/^artifacts\/research\.md$/, /^artifacts\/clarifications\.md$/],
	architect: [/^artifacts\/architecture\.md$/, /^artifacts\/decisions\.md$/, /^artifacts\/clarifications\.md$/],
	engineer: [/^artifacts\/clarifications\.md$/], // + source (default allow below)
	reviewer: [/^artifacts\/review\.md$/, /^artifacts\/clarifications\.md$/],
	qa: [/^artifacts\/test-report\.md$/, /^artifacts\/clarifications\.md$/, /(^|\/)tests?\//, /\.test\./, /\.spec\./],
	documenter: [/^artifacts\/changelog\.md$/, /^docs\//, /^README\.md$/, /^artifacts\/clarifications\.md$/],
};

// Artifact md files. Anything not in this set is treated as "source" and allowed for engineer.
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
]);

// Artifacts that live at .workflow/shared/artifacts/ instead of per-workflow.
// These are properties of the codebase, not of an individual task.
const SHARED_ARTIFACTS = new Set(["architecture.md"]);

// ---- state ----

interface RetryRec {
	bumps: number; // failed attempts since last ruling
	ruled: number; // director rulings issued on this key
}
interface PendingApproval {
	stage: Stage;
	sha: string;
	summary: string;
}
interface WfState {
	stages: Record<Stage, { status: "todo" | "in-progress" | "done" | "blocked"; sha?: string; retries?: number }>;
	current: Stage | null;
	rulings: Record<string, RetryRec>; // CLR-id or defect-key → counters
	pendingApproval?: PendingApproval | null;
}

interface ClrIndex {
	open: { id: string; stage: string; raisedBy: string }[];
}

// ---- helpers ----

function repoRoot(): string {
	return process.cwd();
}

function mintId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// Resolution order (P0-3):
//   1. PI_WORKFLOW_ID env var — explicit, and the mechanism subagents rely on (director
//      passes it via `subagent({ env: { PI_WORKFLOW_ID } })`).
//   2. .workflow/.active-id marker — read (and written if absent) by ANY role, director
//      included. This is what makes "kill the director, restart" resume the same
//      workflow instead of minting a fresh id every process start.
//   3. Neither present → mint fresh, write marker.
// wf_new() explicitly mints a NEW id and overwrites the marker — that's how you start a
// second, independent workflow, rather than by restarting the session.
let _sessionId: string | undefined;
function markerPath(): string {
	return path.join(wfRoot(), ".active-id");
}
function sessionId(): string {
	if (_sessionId) return _sessionId;
	try {
		const existing = fs.readFileSync(markerPath(), "utf8").trim();
		if (existing) return (_sessionId = existing);
	} catch {
		// no marker yet — mint below
	}
	const fresh = mintId();
	try {
		fs.mkdirSync(wfRoot(), { recursive: true });
		fs.writeFileSync(markerPath(), fresh);
	} catch {
		// best-effort; if we can't persist it, other sessions just won't converge
	}
	return (_sessionId = fresh);
}
function workflowId(): string {
	if (process.env.PI_WORKFLOW_ID) {
		const safe = process.env.PI_WORKFLOW_ID.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
		if (safe) return safe;
	}
	return sessionId();
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
function busDir(): string {
	return path.join(wfDir(), "bus");
}
function busFile(target: string): string {
	return path.join(busDir(), `${target}.jsonl`);
}

// ---- settings.json config (project overrides global) ----
// Static per-repo settings only (NOT per-process identity like role, which stays env/claim
// based so concurrent director/planner/engineer subagents don't collapse onto one shared
// value). Project: <repo>/.pi/pi-workflow.json   Global: ~/.pi/agent/pi-workflow.json
// Shape: { "skipStages": ["review", "testing"], "requireApproval": ["architecture"], "interceptReads": true }
interface WfConfig {
	skipStages?: string[];
	requireApproval?: string[];
	interceptReads?: boolean; // P1-2: substitute fresh knowledge fragments for full read() bodies
}
function loadConfig(): WfConfig {
	const globalPath = path.join(os.homedir(), ".pi", "agent", "pi-workflow.json");
	const projectPath = path.join(repoRoot(), ".pi", "pi-workflow.json");
	const g = readJson<WfConfig>(globalPath, {});
	const p = readJson<WfConfig>(projectPath, {});
	return { skipStages: p.skipStages ?? g.skipStages, requireApproval: p.requireApproval ?? g.requireApproval, interceptReads: p.interceptReads ?? g.interceptReads };
}

// ---- role (P0-2) ----

// In-process only — never written to disk, never inherited by a spawned child (children get
// their identity from PI_WORKFLOW_ROLE env, set explicitly by the director's subagent dispatch).
let _claimedRole: string | undefined;

function role(): string {
	const v = process.env.PI_WORKFLOW_ROLE;
	if (v) return v.toLowerCase();
	if (_claimedRole) return _claimedRole;
	return "unassigned";
}
// Gating (role allowlist, CLR gate, tool ceiling) activates the moment a role exists —
// including for the director, once claimed. A bare pi session with nothing loaded stays
// "unassigned": untouched, no gating, only wf_status/wf_claim/wf_approve usable.
function workflowActive(): boolean {
	return role() !== "unassigned";
}
function requireDirector(): { ok: false; msg: string } | null {
	const r = role();
	if (r === "unassigned") return { ok: false, msg: "no role claimed — load skill wf-director or set PI_WORKFLOW_ROLE" };
	if (r !== "director") return { ok: false, msg: "director only" };
	return null;
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
function readJsonl(p: string): Array<Record<string, string>> {
	try {
		return fs
			.readFileSync(p, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

// ---- concurrency lock ----
// Detects "is a workflow already running in this dir" via PID liveness.
// Self-heals: if the PID that holds the lock is dead (session was killed /
// quit), the lock is considered stale and silently reclaimed — no manual
// unlock step needed after an abort.
// (C7) heartbeatAt field removed: it was never consulted for staleness — liveness is,
// and always was, PID-only (process.kill(pid, 0)). A field nobody reads is dead weight.

interface LockInfo {
	pid: number;
	host: string;
	startedAt: string;
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
 *  LockInfo if another live process already holds it.
 *  Acquisition of a *new* lock (no existing file yet) uses `wx` exclusive-create to
 *  close the read-then-write TOCTOU race between two directors starting at the same
 *  instant — only one process's exclusive create can win; the loser falls back to
 *  reading what the winner wrote and reports it as foreign. Refreshing our own
 *  existing lock still uses a plain write since we already own it. */
function acquireOrCheckLock(): LockInfo | null {
	const existing = readLock();
	if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
		return existing; // foreign + alive → caller must not proceed
	}
	const info: LockInfo = {
		pid: process.pid,
		host: os.hostname(),
		startedAt: existing && existing.pid === process.pid ? existing.startedAt : new Date().toISOString(),
	};
	if (!existing) {
		// No lock file observed — try to win it atomically via exclusive create.
		fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
		try {
			const fd = fs.openSync(lockPath(), "wx");
			fs.writeSync(fd, JSON.stringify(info, null, 2));
			fs.closeSync(fd);
			return null; // we won the race
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") {
				// Someone else won the race between our read and our create attempt.
				const winner = readLock();
				if (winner && winner.pid !== process.pid && isPidAlive(winner.pid)) return winner;
				// Winner turned out to be us, dead, or unreadable — fall through to reclaim below.
			} else {
				throw e;
			}
		}
	}
	writeJson(lockPath(), info);
	return null;
}
function loadState(): WfState {
	const empty: WfState = {
		stages: Object.fromEntries(STAGES.map((s) => [s, { status: "todo" }])) as WfState["stages"],
		current: null,
		rulings: {},
		pendingApproval: null,
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

// Stages to auto-skip by default, via skipStages in .pi/pi-workflow.json (or
// ~/.pi/agent/pi-workflow.json). wf_stage_start chains through them automatically;
// wf_stage_complete waives their artifact requirement too.
function skipStagesSet(): Set<Stage> {
	const names = (loadConfig().skipStages ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
	return new Set(names.filter((n): n is Stage => (STAGES as readonly string[]).includes(n)));
}
function requireApprovalSet(): Set<Stage> {
	const names = (loadConfig().requireApproval ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
	return new Set(names.filter((n): n is Stage => (STAGES as readonly string[]).includes(n)));
}

// ---- architecture.md freshness (git-diff based, no full re-scan) ----
// architecture.md is stamped with a `<!-- generated-at-sha: <sha> -->` marker on its
// first line whenever the Architect writes it. Before making the Architect regenerate
// it, we check whether the tree actually changed since that sha via `git diff --quiet`
// (excluding .workflow/ and node_modules/) — cheap, no need to re-read every file.
const ARCH_STAMP_RE = /^<!--\s*generated-at-sha:\s*([0-9a-f]{7,40})\s*-->/i;

function currentGitSha(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot(), encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}
function readArchStamp(): string | null {
	try {
		const text = fs.readFileSync(artifactPath("architecture.md"), "utf8");
		const m = ARCH_STAMP_RE.exec(text);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}
/** True when architecture.md exists, is stamped, and the repo tree (excluding
 *  .workflow/ and node_modules/) is unchanged since that stamped sha. */
function isArchitectureFresh(): { fresh: boolean; sha: string | null } {
	const stamped = readArchStamp();
	const head = currentGitSha();
	if (!stamped || !head) return { fresh: false, sha: head };
	if (stamped === head) return { fresh: true, sha: head };
	try {
		execFileSync("git", ["diff", "--quiet", stamped, head, "--", ".", ":!.workflow", ":!node_modules"], { cwd: repoRoot() });
		return { fresh: true, sha: head }; // exit 0 → no diff → still fresh
	} catch {
		return { fresh: false, sha: head }; // non-zero exit → diff found, or git error
	}
}
/** Rewrite/insert the `generated-at-sha` stamp as the first line of architecture.md. */
function stampArchitecture(sha: string): void {
	const p = artifactPath("architecture.md");
	let text: string;
	try {
		text = fs.readFileSync(p, "utf8");
	} catch {
		return;
	}
	const stampLine = `<!-- generated-at-sha: ${sha} -->`;
	text = ARCH_STAMP_RE.test(text) ? text.replace(ARCH_STAMP_RE, stampLine) : `${stampLine}\n${text}`;
	fs.writeFileSync(p, text);
}

function saveState(state: WfState): void {
	writeJson(statePath(), state);
}

// (C4) Exact-shape stub check, not "includes _empty_ anywhere" — the old substring check
// mis-flagged any artifact that merely *quoted* the sentinel token as still being a stub.
// The stub template wf_init writes is exactly `# <title>\n\n_empty_\n`; match that shape.
const STUB_RE = /^#\s.*\n\n_empty_\s*$/;
function isStubContent(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed === "") return true;
	return STUB_RE.test(trimmed);
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
	if (!allow) return { ok: false, reason: `unknown or unassigned role "${r}" — claim a role first` };

	const ns = wfNamespaceRel(relPath);
	if (ns.inside) {
		// Cross-namespace: never allowed, regardless of role. Keeps concurrent
		// workflows (different PI_WORKFLOW_ID in the same repo) isolated.
		if (ns.kind === "foreign") {
			return { ok: false, reason: `path belongs to a different workflow namespace than PI_WORKFLOW_ID=${workflowId()}` };
		}

		// .workflow/shared/artifacts/ — codebase-level artifacts (architecture.md), reachable
		// from every workflow id. Only the architect role may write these — the Director
		// must delegate to the architect subagent instead.
		if (ns.kind === "shared") {
			const isArtifact = ns.inner.startsWith("artifacts/");
			const filename = ns.inner.slice("artifacts/".length);
			if (!isArtifact || !SHARED_ARTIFACTS.has(filename)) {
				return { ok: false, reason: `.workflow/shared/ only holds shared artifacts (${[...SHARED_ARTIFACTS].join(", ")})` };
			}
			// Director must NOT write shared artifacts — delegate to the architect subagent.
			if (r === "director") {
				return { ok: false, reason: `director may not write ${relPath} — delegate to the architect subagent` };
			}
			const match = allow.some((re) => re.test(ns.inner));
			return match
				? { ok: true }
				: { ok: false, reason: `${r} not permitted to write ${relPath}` };
		}

		// Non-artifact state files (state.json, clr-index.json, director.lock, bus/): director only.
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
	const hint = ARTIFACT_MDS.has(basename) ? ` (did you mean .workflow/${hintDir}/artifacts/${basename}?)` : "";
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
	installSubagentTool(pi);
	// Reset tool counter on session start / switch / reload
	pi.on("session_start", async (_event, _ctx) => {
		resetToolCalls();
	});

	// --- tool_call hook: 50-call ceiling + role + CLR gate ---
	// The 50-call ceiling and the role/CLR gate only activate once a workflow is actually
	// in play (workflowActive()) — a bare "unassigned" session (extension installed but no
	// role claimed / env set) is completely untouched. See role()/workflowActive().
	pi.on("tool_call", async (event, _ctx) => {
		// Ceiling only applies to a session with an active role.
		if (workflowActive()) toolCalls += 1;

		// (C3) Hard-stop (cap+5) is checked FIRST and independently of the soft ceiling, and
		// applies to every tool except the two escalation channels. The old nesting made the
		// hard-stop reachable only for tools that were also in CEILING_EXEMPT (write/edit/
		// wf_clr_open/intercom), and then re-exempted wf_clr_open/intercom from it — so it
		// could only ever fire for write/edit, the opposite of "stop everything but let the
		// agent escalate."
		const HARD_STOP_EXEMPT = ["wf_clr_open", "wf_msg_post"];
		const CEILING_EXEMPT = ["write", "edit", "wf_clr_open", "wf_msg_post", "intercom"];
		if (workflowActive() && toolCalls > TOOL_CAP + 5) {
			if (!HARD_STOP_EXEMPT.includes(event.toolName)) {
				return { block: true, reason: `pi-workflow: hard stop at ${toolCalls} tool calls. Director must reassign.` };
			}
		} else if (workflowActive() && toolCalls > TOOL_CAP) {
			if (!CEILING_EXEMPT.includes(event.toolName)) {
				return {
					block: true,
					reason: `pi-workflow: session hit ${TOOL_CAP}-tool ceiling (call ${toolCalls}). Mark your artifact \`DRAFT — incomplete, split required\`, propose sub-tasks, notify Director via wf_clr_open or wf_msg_post, then stop.`,
				};
			}
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		// No role active — untouched casual session. See workflowActive().
		if (!workflowActive()) return undefined;

		const p = (event.input as { path?: string }).path;
		if (!p) return undefined;
		const rel = relFromRepo(p);

		// Skip files outside repo root — not our business.
		if (rel.startsWith("..")) return undefined;

		const r = role();

		// 1. Role allowlist — hard-enforced for every role now, director included (P0-2).
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

	// --- tool_result hook: P1-2 mechanical read interception (opt-in) ---
	// Unlike tool_call (block-only), tool_result CAN substitute a tool's content. When
	// config.interceptReads is on and a role is active, a full-file `read` of a source that
	// already has FRESH knowledge fragments (mtime+size match) returns the fragment(s)
	// instead of the raw body — the token win the plan wanted, enforced mechanically.
	// Guardrails (why this is safe + opt-in, not default):
	//   - Only full reads are intercepted. Passing offset OR limit is the escape hatch that
	//     always yields raw source (an engineer about to edit a file reads a slice / uses
	//     offset:1 to force the real bytes).
	//   - Never intercepts .workflow/ artifacts or files without fresh fragments.
	pi.on("tool_result", async (event, _ctx) => {
		if (!workflowActive()) return undefined;
		if (!loadConfig().interceptReads) return undefined;
		if (!isReadToolResult(event) || event.isError) return undefined;
		const input = event.input as { path?: string; offset?: number; limit?: number };
		if (!input.path) return undefined;
		if (input.offset != null || input.limit != null) return undefined; // escape hatch: raw source
		const rel = relFromRepo(input.path);
		if (rel.startsWith("..") || rel.startsWith(".workflow/")) return undefined;
		const { sections } = freshFragments(rel);
		if (!sections.length) return undefined;
		const header = `cached analysis (mtime+size still match) — re-run read with an offset to force raw source.\n\n`;
		return { content: [{ type: "text", text: header + sections.join("\n\n") }] };
	});

	// --- wf_claim ---
	pi.registerTool({
		name: "wf_claim",
		label: "wf_claim",
		description:
			"Claim a role for THIS process only (in-memory, never written to disk, never inherited by subagents). Loading skill wf-director calls wf_claim(\"director\") as step 0 — that is what makes a session the director, not merely being unassigned.",
		parameters: Type.Object({ role: StringEnum(["director"]) }),
		async execute(_id, params) {
			if (process.env.PI_WORKFLOW_ROLE) {
				return deny(`role already fixed via env PI_WORKFLOW_ROLE=${process.env.PI_WORKFLOW_ROLE} — wf_claim not needed/applicable`);
			}
			_claimedRole = params.role;
			return ok(`claimed role: ${params.role} (in-process only)`);
		},
	});

	// --- wf_new ---
	pi.registerTool({
		name: "wf_new",
		label: "wf_new",
		description: "Mint a fresh workflow id, update the resume marker, and return it. Use this to start a second/parallel workflow instead of relying on session restart. Director only.",
		parameters: Type.Object({ label: Type.Optional(Type.String({ description: "short human label appended to the id" })) }),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			if (process.env.PI_WORKFLOW_ID) {
				return deny(`PI_WORKFLOW_ID=${process.env.PI_WORKFLOW_ID} is set explicitly — wf_new cannot override an env-pinned id; unset it or start a new process/env for a second workflow`);
			}
			const label = params.label ? params.label.trim().replace(/[^a-zA-Z0-9._-]/g, "-") : "";
			const fresh = label ? `${mintId()}-${label}` : mintId();
			_sessionId = fresh;
			try {
				fs.mkdirSync(wfRoot(), { recursive: true });
				fs.writeFileSync(markerPath(), fresh);
			} catch {
				// best-effort
			}
			return ok(`new workflow id: ${fresh} (marker updated — call wf_init next)`);
		},
	});

	// --- wf_list ---
	pi.registerTool({
		name: "wf_list",
		label: "wf_list",
		description: "Enumerate .workflow/<id>/ namespaces in this repo with current stage and director-lock liveness. Any role.",
		parameters: Type.Object({}),
		async execute() {
			const root = wfRoot();
			let ids: string[] = [];
			try {
				ids = fs
					.readdirSync(root, { withFileTypes: true })
					.filter((d) => d.isDirectory() && d.name !== "shared")
					.map((d) => d.name);
			} catch {
				// no .workflow/ yet
			}
			if (!ids.length) return { content: [{ type: "text", text: "no workflows found" }], details: { ids: [] } };
			const lines = ids.map((id) => {
				const st = readJson<WfState | null>(path.join(root, id, "state.json"), null);
				const lock = readJson<LockInfo | null>(path.join(root, id, "director.lock"), null);
				const lockStr = lock ? (isPidAlive(lock.pid) ? `ALIVE pid ${lock.pid}` : "STALE") : "none";
				const marker = id === (_sessionId ?? "") ? " (this session)" : "";
				return `${id}${marker}: current=${st?.current ?? "—"} lock=${lockStr}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: { ids } };
		},
	});

	// --- wf_init ---
	pi.registerTool({
		name: "wf_init",
		label: "wf_init",
		description: "Initialize .workflow/ state and stub artifacts. Director only.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			fs.mkdirSync(artifactsDir(), { recursive: true });

			// (C5) Ask before writing .gitignore (when there's a UI to ask through), and match
			// both ".workflow" and ".workflow/" forms — the old check only looked for the
			// slashed form and would append a duplicate entry for a bare ".workflow" line.
			const gitignorePath = path.join(repoRoot(), ".gitignore");
			const hasEntryRe = /(^|\n)\s*\.workflow\/?\s*($|\n)/;
			if (fs.existsSync(gitignorePath)) {
				const gitignore = fs.readFileSync(gitignorePath, "utf8");
				if (!hasEntryRe.test(gitignore)) {
					let proceed = true;
					const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: { confirm: (t: string, m: string) => Promise<boolean> } };
					if (anyCtx?.hasUI && anyCtx.ui?.confirm) {
						proceed = await anyCtx.ui.confirm("pi-workflow", 'Append ".workflow/" to .gitignore?');
					}
					if (proceed) fs.appendFileSync(gitignorePath, "\n.workflow/\n");
				}
			} else {
				fs.writeFileSync(gitignorePath, ".workflow/\n");
			}
			const foreign = acquireOrCheckLock();
			if (foreign) {
				return {
					content: [{
						type: "text",
						text: `BLOCKED: another director session is already running workflow "${workflowId()}" (pid ${foreign.pid} on ${foreign.host}, started ${foreign.startedAt}). ` +
							`If that session is dead, it will self-clear next time this is called. To work on a second feature in parallel in this same repo, call wf_new (or set a distinct PI_WORKFLOW_ID, e.g. PI_WORKFLOW_ID=notifications) before calling wf_init — each id gets its own isolated .workflow/<id>/ lock, state, and artifacts. Alternatively use a separate git worktree.`,
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
				const stub = `# ${md.replace(".md", "")}\n\n_empty_\n`;
				const content = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
				if (content === null || isStubContent(content)) fs.writeFileSync(abs, stub);
			}
			return { content: [{ type: "text", text: "workflow initialized" }], details: { ok: true } };
		},
	});

	// --- wf_stage_start ---
	pi.registerTool({
		name: "wf_stage_start",
		label: "wf_stage_start",
		description: "Set current stage to <stage>. Director only. Rejects if previous stage not done. Stages listed in skipStages config are auto-skipped and chained through.",
		parameters: Type.Object({ stage: StringEnum([...STAGES]) }),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const state = loadState();
			const target = params.stage as Stage;
			const idx = stageIndex(target);
			if (idx > 0) {
				const prevOk = state.stages[STAGES[idx - 1]].status === "done";
				if (!prevOk) {
					return deny(`previous stage "${STAGES[idx - 1]}" not done`);
				}
			}
			// --- auto-skip chain: fast-forward through any configured skip stages ---
			fs.mkdirSync(artifactsDir(), { recursive: true }); // guard: ensure dir exists even if wf_init wasn't called first
			const skip = skipStagesSet();
			const clrForSkip = loadClr();
			const skippedChain: Stage[] = [];
			const freshChain: Stage[] = [];
			let cur: Stage | null = target;
			while (cur) {
				// An OPEN CLR at or before this stage must stop the auto-skip chain here —
				// otherwise a stage with an unresolved clarification gets silently marked
				// "done" via config, leaving state internally inconsistent. Surface it as the
				// normal in-progress/blocked stage instead so the director resolves it normally.
				if (clrBlocksStage(clrForSkip, cur).blocked) break;
				if (skip.has(cur)) {
					state.stages[cur].status = "done";
					state.stages[cur].sha = "auto-skip";
					skippedChain.push(cur);
					cur = nextStage(cur);
					continue;
				}
				// architecture is never blanket-skipped, but IS skipped when the repo tree
				// hasn't changed since architecture.md was last stamped (git-diff check,
				// no full re-scan needed).
				if (cur === "architecture") {
					const { fresh, sha: headSha } = isArchitectureFresh();
					if (fresh && headSha) {
						state.stages[cur].status = "done";
						state.stages[cur].sha = headSha;
						freshChain.push(cur);
						cur = nextStage(cur);
						continue;
					}
				}
				break;
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
					`\n## auto-skip (skipStages config)\n- Skipped: ${skippedChain.join(", ")}\n`,
				);
			}
			if (freshChain.length) {
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## auto-skip (architecture.md unchanged since last stamp)\n- Skipped: ${freshChain.join(", ")}\n`,
				);
			}
			acquireOrCheckLock(); // refresh lock; also self-reclaims a stale one

			// Reset per-stage tool budget so each stage gets a fresh 50-call cap
			resetToolCalls();

			const allSkipped = [...skippedChain, ...freshChain];

			// (C1) Auto-skipped stages are ALREADY marked done above — do not instruct the
			// director to call wf_stage_complete(sha:"auto-skip") for them, that sha fails the
			// `^[0-9a-f]{7,40}$` validation and produced an infinite BLOCKED loop. Say so
			// explicitly. (wf_stage_complete also now no-ops safely if called anyway — see C1
			// note there.)
			if (!cur) {
				return ok(`stage(s) skipped: ${allSkipped.join(", ")}. Workflow reached end — no stage in-progress. Do NOT call wf_stage_complete for skipped stages, they are already "done".`);
			}

			// Delegation guidance (P0-1): env passthrough, not a task-text prefix convention.
			const delegateRole = ROLE_FOR_STAGE[cur];
			const artifacts = ARTIFACT_FOR_STAGE[cur];
			const artifactList = artifacts.length ? artifacts.join(", ") : "source code";
			const skippedNote = allSkipped.length
				? ` (auto-skipped: ${allSkipped.join(", ")} — do NOT call wf_stage_complete for those, they are already "done")`
				: "";
			const hint = [
				`\n\nDELEGATE: subagent({ agent: "${delegateRole}", env: { PI_WORKFLOW_ROLE: "${delegateRole}", PI_WORKFLOW_ID: "${workflowId()}" }, task: "Load skill wf-${delegateRole}. ..." })`,
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
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const state = loadState();
			const clr = loadClr();
			const stage = params.stage as Stage;

			// (C1) Already-done stage (auto-skip, or a stray repeat call) → APPROVED no-op
			// instead of running the full checklist (which would reject a non-sha "auto-skip"
			// marker and BLOCK forever).
			if (state.stages[stage].status === "done" && !params.skip) {
				return {
					content: [{ type: "text", text: `APPROVED (noop) — ${stage} already done @ ${state.stages[stage].sha ?? "?"}` }],
					details: { ok: true, decision: "APPROVED", stage, sha: state.stages[stage].sha, noop: true },
				};
			}

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

			// 1. artifact exists — waived for stages configured via skipStages config
			const autoSkip = skipStagesSet().has(stage);
			for (const art of autoSkip ? [] : ARTIFACT_FOR_STAGE[stage]) {
				const abs = artifactPath(art);
				if (!fs.existsSync(abs) || isStubContent(fs.readFileSync(abs, "utf8"))) {
					errors.push(`artifact missing or stub: ${art}`);
				}
			}

			// 2. CLR gate
			const gate = clrBlocksStage(clr, stage);
			if (gate.blocked) errors.push(`OPEN CLRs block: ${gate.ids.join(", ")}`);

			// 3. (C2) retry limit — >= 3, matching wf_retry_bump's own DIRECTOR_RULE threshold.
			// Previously this used `> 3`, one bump later than the bump tool itself warned at.
			const stuckKeys = Object.entries(state.rulings).filter(([, rec]) => rec.bumps >= 3).map(([key]) => key);
			if (stuckKeys.length) errors.push(`retry cap exceeded for key(s) needing wf_retry_rule: ${stuckKeys.join(", ")}`);

			// 4. SHA sanity
			if (!/^[0-9a-f]{7,40}$/i.test(sha)) errors.push(`bad sha: ${sha}`);

			if (errors.length) {
				return {
					content: [{ type: "text", text: `BLOCKED\n- ${errors.join("\n- ")}` }],
					details: { ok: false, decision: "BLOCKED", errors },
				};
			}

			// --- P3: human-in-the-loop gate ---
			// A stage listed in requireApproval does NOT get marked done here. Instead this
			// halts with AWAITING_HUMAN and a summary; only wf_approve (callable exclusively by
			// an "unassigned" — i.e. human — session) can finalize it.
			if (requireApprovalSet().has(stage)) {
				const summary = [
					"## produced",
					`- artifact(s): ${ARTIFACT_FOR_STAGE[stage].join(", ") || "source code"}`,
					"## next",
					`- director intends to proceed to: ${nextStage(stage) ?? "(workflow end)"}`,
					"## question",
					`- is this correct? good to proceed? call wf_approve(stage="${stage}", sha="${sha}", verdict="approve"|"reject", note?)`,
				].join("\n");
				state.pendingApproval = { stage, sha, summary };
				saveState(state);
				return {
					content: [{ type: "text", text: `AWAITING_HUMAN\n${summary}` }],
					details: { ok: false, decision: "AWAITING_HUMAN", stage, sha },
				};
			}

			if (stage === "architecture") {
				const head = currentGitSha();
				if (head) stampArchitecture(head); // record what tree state this architecture.md reflects
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

	// --- wf_approve (P3) ---
	pi.registerTool({
		name: "wf_approve",
		label: "wf_approve",
		description: "Approve or reject a stage awaiting the human gate (see requireApproval config). Callable ONLY by an unassigned (human) session — never by director or any agent role.",
		parameters: Type.Object({
			stage: StringEnum([...STAGES]),
			sha: Type.String(),
			verdict: StringEnum(["approve", "reject"]),
			note: Type.Optional(Type.String({ description: "required context for reject — becomes the correction brief" })),
		}),
		async execute(_id, params) {
			if (role() !== "unassigned") return deny("wf_approve is human-only — no claimed/env role may call it");
			const state = loadState();
			if (!state.pendingApproval || state.pendingApproval.stage !== params.stage || state.pendingApproval.sha !== params.sha) {
				return deny(`no matching pending approval for stage=${params.stage} sha=${params.sha}`);
			}
			if (params.verdict === "reject") {
				state.pendingApproval = null;
				state.stages[params.stage as Stage].status = "in-progress";
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## human rejection: ${params.stage} @ ${params.sha.slice(0, 7)}\n${params.note ?? "(no note given)"}\n`,
				);
				return ok(`REJECTED ${params.stage} — reset to in-progress with correction note in decisions.md`);
			}
			if (params.stage === "architecture") {
				const head = currentGitSha();
				if (head) stampArchitecture(head);
			}
			state.stages[params.stage as Stage].status = "done";
			state.stages[params.stage as Stage].sha = params.sha;
			state.current = nextStage(params.stage as Stage);
			state.pendingApproval = null;
			saveState(state);
			return ok(`APPROVED (human) ${params.stage} @ ${params.sha.slice(0, 7)}`);
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
			// mark stage blocked — but only if it isn't already "done". Filing a CLR against
			// a stage the workflow has already progressed past shouldn't retroactively flip
			// its recorded status backward and corrupt the audit trail; the open CLR still
			// blocks all further writes via clrBlocksStage regardless of this status field.
			const state = loadState();
			const target = state.stages[params.stage as Stage];
			if (target && target.status !== "done") {
				target.status = "blocked";
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
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const clr = loadClr();
			const before = clr.open.length;
			const target = clr.open.find((c) => c.id === params.id);
			clr.open = clr.open.filter((c) => c.id !== params.id);
			if (clr.open.length === before) return deny(`no OPEN CLR with id ${params.id}`);
			writeJson(clrIndexPath(), clr);
			// append resolution note
			fs.appendFileSync(
				path.join(artifactsDir(), "clarifications.md"),
				`\n<!-- ${params.id} resolved by director: ${params.resolution} -->\n`,
			);
			// (C6) Restore "blocked" → "in-progress" once nothing else still blocks that stage —
			// previously a resolved CLR left the stage's status permanently stuck at "blocked"
			// even though clrBlocksStage() (the thing that actually gates writes) had already
			// cleared. status was write-only: set by wf_clr_open, never consulted or restored.
			if (target) {
				const state = loadState();
				const stageRec = state.stages[target.stage as Stage];
				if (stageRec && stageRec.status === "blocked" && !clrBlocksStage(clr, target.stage as Stage).blocked) {
					stageRec.status = "in-progress";
					saveState(state);
				}
			}
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
			// NOTE: bumps live only on state.rulings[key] — keyed by defect key, not by
			// "whichever stage happens to be state.current right now". A defect bumped once
			// during review and again during testing (same key, per docs: "same-bug key spans
			// Review+QA loops") must accumulate correctly across that stage boundary; mirroring
			// onto state.current would silently split the count across two unrelated stage
			// counters instead. wf_stage_complete's retry-cap check (step 3, "retry limit")
			// reads state.rulings directly instead of a per-stage mirror.
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
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const state = loadState();
			const rec = state.rulings[params.key] ?? { bumps: 0, ruled: 0 };
			rec.ruled += 1;
			rec.bumps = 0;
			state.rulings[params.key] = rec;
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
		description: "Dump workflow state, current stage, open CLRs. Any role, including unassigned.",
		parameters: Type.Object({}),
		async execute() {
			const state = loadState();
			const clr = loadClr();
			const lock = readLock();
			const lockLine = lock
				? `lock: pid ${lock.pid} on ${lock.host} (${isPidAlive(lock.pid) ? "ALIVE" : "STALE — will be reclaimed"}), started ${lock.startedAt}`
				: "lock: none";
			const lines = [
				`role: ${role()}`,
				`workflow id: ${workflowId()}`,
				`current: ${state.current ?? "—"}`,
				`open CLRs: ${clr.open.length ? clr.open.map((c) => `${c.id}(${c.stage})`).join(", ") : "none"}`,
				`pending approval: ${state.pendingApproval ? `${state.pendingApproval.stage} @ ${state.pendingApproval.sha}` : "none"}`,
				lockLine,
				"",
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { state, clr, lock } };
		},
	});

	// --- wf_write_artifact (C9: reconcile the divergence — this tool was registered by
	// some installed copy but absent from this canonical index.ts) ---
	pi.registerTool({
		name: "wf_write_artifact",
		label: "wf_write_artifact",
		description: "Safely writes a workflow artifact to .workflow/<id>/artifacts/. Cannot touch source files.",
		parameters: Type.Object({
			filename: Type.String({ description: "artifact filename, e.g. plan.md, research.md" }),
			content: Type.String(),
		}),
		async execute(_id, params) {
			if (!ARTIFACT_MDS.has(params.filename)) {
				return deny(`"${params.filename}" is not a recognized workflow artifact (${[...ARTIFACT_MDS].join(", ")})`);
			}
			const r = role();
			const rel = SHARED_ARTIFACTS.has(params.filename)
				? `.workflow/shared/artifacts/${params.filename}`
				: `.workflow/${workflowId()}/artifacts/${params.filename}`;
			const allow = isPathAllowedForRole(r, rel);
			if (!allow.ok) return deny(allow.reason ?? "not permitted");

			const state = loadState();
			const clr = loadClr();
			const gate = clrBlocksStage(clr, state.current);
			const isClarifications = params.filename === "clarifications.md";
			if (gate.blocked && !isClarifications) {
				return deny(`OPEN CLR(s) block writes: ${gate.ids.join(", ")}. Resolve via wf_clr_resolve before editing.`);
			}

			const abs = artifactPath(params.filename);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, params.content);
			if (params.filename === "architecture.md") {
				const head = currentGitSha();
				if (head) stampArchitecture(head);
			}
			return ok(`wrote ${params.content.length} chars to ${params.filename}`);
		},
	});

	// --- wf_knowledge_put / wf_knowledge_get (P1-1) ---
	pi.registerTool({
		name: "wf_knowledge_put",
		label: "wf_knowledge_put",
		description: "Store an immutable analysis fragment about a source file so other agents (or future workflow runs) can reuse it instead of re-deriving. scope=general is durable/repo-wide; scope=task is disposable, this workflow only.",
		parameters: Type.Object({
			file: Type.String({ description: "repo-relative path of the source file this note is about" }),
			note: Type.String(),
			scope: StringEnum(["general", "task"]),
		}),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const dir = knowledgeDir(params.file, params.scope as "general" | "task");
			fs.mkdirSync(dir, { recursive: true });
			let mtime = "";
			let size = "";
			try {
				const st = fs.statSync(path.resolve(repoRoot(), params.file));
				mtime = String(st.mtimeMs);
				size = String(st.size);
			} catch {
				// source file doesn't exist (yet, or was deleted) — fragment is always stale on read
			}
			const frag = `---\nfile: ${params.file}\nrole: ${role()}\nmtime: ${mtime}\nsize: ${size}\nwritten: ${new Date().toISOString()}\n---\n${params.note.trim()}\n`;
			const name = `${process.pid}-${Date.now()}-${role()}.md`;
			const tmp = path.join(dir, `.tmp-${name}`);
			fs.writeFileSync(tmp, frag);
			fs.renameSync(tmp, path.join(dir, name)); // atomic — immutable fragments never collide
			return ok(`stored fragment ${name} (scope=${params.scope})`);
		},
	});
	pi.registerTool({
		name: "wf_knowledge_get",
		label: "wf_knowledge_get",
		description: "Retrieve stored analysis fragments about a source file — general (repo-wide) and task (this workflow) scope — filtered to ones still fresh (mtime+size match). Call before reading a source file another agent may already have analyzed.",
		parameters: Type.Object({ file: Type.String() }),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const { sections, staleCount } = freshFragments(params.file);
			const staleNote = staleCount ? `\n\n_${staleCount} stale fragment(s) skipped — file changed since last analysis._` : "";
			const text = sections.length ? `${sections.join("\n\n")}${staleNote}` : `no fragments found for ${params.file}${staleNote}`;
			return { content: [{ type: "text", text }], details: { ok: true } };
		},
	});

	// --- wf_msg_post / wf_msg_poll / wf_bus_digest (P2: agent bus) ---
	// Replaces `intercom` for subagent<->subagent and subagent<->director coordination:
	// intercom targets interactive sessions by discoverable name, which dispatched
	// subagents don't have, and its messages die with the process. The bus is plain
	// per-role JSONL under .workflow/<id>/bus/, appended via a single appendFileSync call
	// (same atomicity argument as wf_context_append had) — survives process death, fully
	// auditable after the run.
	pi.registerTool({
		name: "wf_msg_post",
		label: "wf_msg_post",
		description: 'Post a message to another role\'s bus, or "all". Survives process death; readable after both sender and recipient exit.',
		parameters: Type.Object({
			to: Type.String({ description: 'role name (e.g. "engineer") or "all"' }),
			body: Type.String(),
			threadId: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			fs.mkdirSync(busDir(), { recursive: true });
			const target = params.to.toLowerCase() === "all" ? "all" : params.to.toLowerCase();
			const msg = {
				id: crypto.randomBytes(4).toString("hex"),
				from: role(),
				to: target,
				body: params.body,
				threadId: params.threadId ?? "",
				ts: new Date().toISOString(),
			};
			fs.appendFileSync(busFile(target), `${JSON.stringify(msg)}\n`); // single write() syscall — atomic under concurrent writers
			return ok(`posted to ${target}: ${msg.id}`);
		},
	});
	pi.registerTool({
		name: "wf_msg_poll",
		label: "wf_msg_poll",
		description: 'Poll messages addressed to caller\'s role or "all", optionally only since an ISO timestamp.',
		parameters: Type.Object({ since: Type.Optional(Type.String({ description: "ISO timestamp — only messages strictly after this" })) }),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const r = role();
			let msgs = [...readJsonl(busFile(r)), ...readJsonl(busFile("all"))];
			msgs.sort((a, b) => (a.ts as string).localeCompare(b.ts as string));
			if (params.since) msgs = msgs.filter((m) => (m.ts as string) > params.since!);
			const text = msgs.length ? msgs.map((m) => `[${m.ts}] ${m.from}→${m.to}: ${m.body}`).join("\n") : "no messages";
			return { content: [{ type: "text", text }], details: { messages: msgs } };
		},
	});
	pi.registerTool({
		name: "wf_bus_digest",
		label: "wf_bus_digest",
		description: "Full bus transcript across every role, oldest first. Director only.",
		parameters: Type.Object({}),
		async execute() {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			let files: string[] = [];
			try {
				files = fs.readdirSync(busDir()).filter((f) => f.endsWith(".jsonl"));
			} catch {
				// no bus activity yet
			}
			const msgs = files.flatMap((f) => readJsonl(path.join(busDir(), f)));
			msgs.sort((a, b) => (a.ts as string).localeCompare(b.ts as string));
			const text = msgs.length ? msgs.map((m) => `[${m.ts}] ${m.from}→${m.to}: ${m.body}`).join("\n") : "no messages";
			return { content: [{ type: "text", text }], details: { messages: msgs } };
		},
	});

	// --- wf_artifact_summary (P4: director token diet) ---
	// Director previously read every artifact in full for every poll. This returns only
	// heading/verdict lines (`## ...`, `verdict:`, `DRAFT — incomplete` markers) — cheap
	// enough to call after every subagent report. Read the full artifact only on BLOCKED
	// or immediately before presenting an AWAITING_HUMAN summary.
	pi.registerTool({
		name: "wf_artifact_summary",
		label: "wf_artifact_summary",
		description: "Return only heading/verdict lines from an artifact (## headings, `verdict:` lines, DRAFT markers) instead of the full text — cheap director polling. Read the full artifact only on BLOCKED or before a human-gate summary.",
		parameters: Type.Object({ artifact: Type.String({ description: "artifact filename, e.g. review.md" }) }),
		async execute(_id, params) {
			const abs = artifactPath(params.artifact);
			let text: string;
			try {
				text = fs.readFileSync(abs, "utf8");
			} catch {
				return deny(`no such artifact: ${params.artifact}`);
			}
			const lines = text.split("\n").filter((l) => /^#{1,3}\s/.test(l) || /verdict\s*:/i.test(l) || /DRAFT — incomplete/i.test(l));
			return {
				content: [{ type: "text", text: lines.length ? lines.join("\n") : "(no heading/verdict lines found — read in full)" }],
				details: { ok: true },
			};
		},
	});
}

// ---- knowledge helpers (P1-1) ----
function sanitizeFilePath(file: string): string {
	return file
		.replace(/^\.\/?/, "")
		.replace(/\.\./g, "_")
		.replace(/[\\/]/g, "__")
		.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function knowledgeDir(file: string, scope: "general" | "task"): string {
	const base = scope === "general" ? path.join(wfRoot(), "shared", "knowledge") : path.join(wfDir(), "knowledge");
	return path.join(base, sanitizeFilePath(file));
}

// Collect fresh (mtime+size still matching the on-disk source) fragments for a file.
// Shared by wf_knowledge_get and the P1-2 read-interception hook.
function freshFragments(file: string): { sections: string[]; staleCount: number } {
	let curMtime = "";
	let curSize = "";
	try {
		const st = fs.statSync(path.resolve(repoRoot(), file));
		curMtime = String(st.mtimeMs);
		curSize = String(st.size);
	} catch {
		// missing source — everything reads as stale, which is correct
	}
	const sections: string[] = [];
	let staleCount = 0;
	const scopes: Array<["general" | "task", string]> = [
		["general", "General (repo-wide)"],
		["task", "Task-specific (this workflow)"],
	];
	for (const [scope, label] of scopes) {
		const dir = knowledgeDir(file, scope);
		let files: string[] = [];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".tmp-")).sort();
		} catch {
			// no fragments for this file/scope yet
		}
		const fresh: string[] = [];
		for (const f of files) {
			const raw = fs.readFileSync(path.join(dir, f), "utf8");
			const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
			if (!fm) continue;
			const meta: Record<string, string> = {};
			for (const line of fm[1].split("\n")) {
				const idx = line.indexOf(":");
				if (idx === -1) continue;
				meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
			if (curMtime && meta.mtime === curMtime && meta.size === curSize) {
				fresh.push(`### ${meta.role ?? "?"} @ ${meta.written ?? "?"}\n${fm[2].trim()}`);
			} else {
				staleCount += 1;
			}
		}
		if (fresh.length) sections.push(`## ${label}\n${fresh.join("\n\n")}`);
	}
	return { sections, staleCount };
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
