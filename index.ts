/**
 * pi-workflow — viability spike
 *
 * Proves three hard parts at once:
 *   1. Custom stateful tools (wf_*) with disk-backed state under .workflow/
 *   2. Role-based path allowlist that hard-blocks write/edit
 *   3. CLR gate that hard-blocks write/edit while any OPEN CLR names current or upstream stage
 *
 * Role is read from env PI_WORKFLOW_ROLE (default: "director").
 * State: .workflow/state.json, .workflow/clr-index.json
 * Artifacts: plan.md, tasks.md, research.md, architecture.md, decisions.md,
 *            clarifications.md, progress.md, review.md, test-report.md, changelog.md
 */

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
	research: ["research.md"],
	"task-breakdown": ["tasks.md"], // director may edit
	architecture: ["architecture.md"],
	implementation: [], // source code, no md gate
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
	director: [/^\.workflow\//, /^progress\.md$/],
	planner: [/^\.workflow\/artifacts\/plan\.md$/, /^\.workflow\/artifacts\/tasks\.md$/, /^\.workflow\/artifacts\/clarifications\.md$/],
	scout: [/^\.workflow\/artifacts\/research\.md$/, /^\.workflow\/artifacts\/clarifications\.md$/],
	architect: [/^\.workflow\/artifacts\/architecture\.md$/, /^\.workflow\/artifacts\/decisions\.md$/, /^\.workflow\/artifacts\/clarifications\.md$/],
	engineer: [/^\.workflow\/artifacts\/clarifications\.md$/], // + source (default allow below)
	reviewer: [/^\.workflow\/artifacts\/review\.md$/, /^\.workflow\/artifacts\/clarifications\.md$/],
	qa: [/^\.workflow\/artifacts\/test-report\.md$/, /^\.workflow\/artifacts\/clarifications\.md$/, /(^|\/)tests?\//, /\.test\./, /\.spec\./],
	documenter: [/^\.workflow\/artifacts\/changelog\.md$/, /^docs\//, /^README\.md$/, /^\.workflow\/artifacts\/clarifications\.md$/],
};

// Artifact md files. Anything not in this set is treated as "source" and allowed for engineer.
const ARTIFACT_MDS = new Set([
	"plan.md",
	"tasks.md",
	"research.md",
	"architecture.md",
	"decisions.md",
	"clarifications.md",
	"progress.md",
	"review.md",
	"test-report.md",
	"changelog.md",
]);

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
function wfDir(): string {
	return path.join(repoRoot(), ".workflow");
}
function artifactsDir(): string {
	return path.join(wfDir(), "artifacts");
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

function isPathAllowedForRole(r: string, relPath: string): { ok: boolean; reason?: string } {
	const allow = ROLE_ALLOW[r];
	if (!allow) return { ok: false, reason: `unknown role "${r}"` };

	// .workflow/ state files (not artifacts): director only.
	if (relPath.startsWith(".workflow/") && !relPath.startsWith(".workflow/artifacts/")) {
		return r === "director" ? { ok: true } : { ok: false, reason: `only director may write .workflow/ state files` };
	}

	// Non-artifact source: engineer + qa (for test files) + documenter allowed by default.
	const isArtifact = relPath.startsWith(".workflow/artifacts/");
	if (!isArtifact) {
		if (r === "engineer" || r === "qa" || r === "documenter") return { ok: true };
		// Others may not touch source.
		// Give a helpful hint if the filename looks like a misplaced artifact.
		const basename = relPath.split("/").pop() || relPath;
		const hint = ARTIFACT_MDS.has(basename) ? ` (did you mean .workflow/artifacts/${basename}?)` : "";
		return { ok: false, reason: `${r} may not modify source (${relPath})${hint}` };
	}

	// Artifact: must match role allowlist.
	const match = allow.some((re) => re.test(relPath));
	return match
		? { ok: true }
		: { ok: false, reason: `${r} not permitted to write ${relPath}` };
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

		// 2. CLR gate — exempt .workflow/ state files and clarifications.md; artifacts still gated.
		const isWfState = rel.startsWith(".workflow/") && !rel.startsWith(".workflow/artifacts/");
		const isClarifications = rel === ".workflow/artifacts/clarifications.md";
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
						text: `BLOCKED: another director session is already running this workflow (pid ${foreign.pid} on ${foreign.host}, started ${foreign.startedAt}, last heartbeat ${foreign.heartbeatAt}). ` +
							`If that session is dead, it will self-clear next time this is called. To work on a second feature in parallel, run this workflow in a separate git worktree instead.`,
					}],
					details: { ok: false, decision: "LOCKED", lock: foreign },
				};
			}
			const state = loadState();
			saveState(state);
			writeJson(clrIndexPath(), loadClr());
			for (const md of ARTIFACT_MDS) {
				const abs = path.join(artifactsDir(), md);
				if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${md.replace(".md", "")}\n\n_empty_\n`);
			}
			return { content: [{ type: "text", text: "workflow initialized" }], details: { ok: true } };
		},
	});

	// --- wf_stage_start ---
	pi.registerTool({
		name: "wf_stage_start",
		label: "wf_stage_start",
		description: "Set current stage to <stage>. Director only. Rejects if previous stage not done.",
		parameters: Type.Object({ stage: StringEnum([...STAGES]) }),
		async execute(_id, params) {
			if (role() !== "director") return deny("director only");
			const state = loadState();
			const target = params.stage as Stage;
			const idx = stageIndex(target);
			if (idx > 0) {
				const prev = STAGES[idx - 1];
				// task-breakdown may run right after research completes (planning ∥ research)
				const prevOk = state.stages[prev].status === "done";
				if (!prevOk && !(target === "task-breakdown" && state.stages.planning.status === "done" && state.stages.research.status === "done")) {
					return deny(`previous stage "${prev}" not done`);
				}
			}
			state.current = target;
			state.stages[target].status = "in-progress";
			saveState(state);
			acquireOrCheckLock(); // refresh heartbeat; also self-reclaims a stale lock

			// Reset per-stage tool budget so each stage gets a fresh 50-call cap
			resetToolCalls();

			// Delegation guidance: tell solo directors to spawn a subagent
			const delegateRole = ROLE_FOR_STAGE[target];
			const artifacts = ARTIFACT_FOR_STAGE[target];
			const artifactList = artifacts.length ? artifacts.join(", ") : "source code";
			const hint = [
				`\n\nDELEGATE: Spawn subagent with agent="${delegateRole}".`,
				`Task prompt must start with "PI_WORKFLOW_ROLE=${delegateRole}" and load skill "wf-${delegateRole}".`,
				`Each subagent gets a fresh context window and ${TOOL_CAP}-tool budget.`,
				`Expected artifacts: ${artifactList}`,
				`When finished, call wf_stage_complete("${target}", sha).`,
			].join(" ");
			return ok(`stage started: ${target}${hint}`);
		},
	});

	// --- wf_stage_complete ---
	pi.registerTool({
		name: "wf_stage_complete",
		label: "wf_stage_complete",
		description: "Run transition checklist for <stage>. Director only. Requires git SHA (git rev-parse HEAD). Blocks if OPEN CLR names this or upstream stage, or required artifact absent.",
		parameters: Type.Object({
			stage: StringEnum([...STAGES]),
			sha: Type.String({ description: "git SHA from git rev-parse HEAD" }),
			skip: Type.Optional(Type.String({ description: "trivial-task escape: skip this and remaining pre-implementation stages, reason logged to decisions.md" })),
		}),
		async execute(_id, params) {
			if (role() !== "director") return deny("director only");
			const state = loadState();
			const clr = loadClr();
			const stage = params.stage as Stage;

			// --- trivial-task escape hatch ---
			if (params.skip) {
				const implIdx = stageIndex("implementation");
				const startIdx = stageIndex(stage);
				if (startIdx === -1 || startIdx >= implIdx) {
					return deny("skip only allowed on pre-implementation stages");
				}
				if (!/^[0-9a-f]{7,40}$/i.test(params.sha)) return deny(`bad sha: ${params.sha}`);
				const skipped: string[] = [];
				for (let i = startIdx; i < implIdx; i++) {
					const s = STAGES[i];
					state.stages[s].status = "done";
					state.stages[s].sha = params.sha;
					skipped.push(s);
				}
				state.current = "implementation";
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## trivial-task skip @ ${params.sha.slice(0, 7)}\n- Skipped: ${skipped.join(", ")}\n- Reason: ${params.skip}\n`,
				);
				return {
					content: [{ type: "text", text: `SKIPPED ${skipped.join(", ")} → implementation` }],
					details: { ok: true, decision: "SKIPPED", skipped, sha: params.sha },
				};
			}

			const errors: string[] = [];

			// 1. artifact exists
			for (const art of ARTIFACT_FOR_STAGE[stage]) {
				const abs = path.join(artifactsDir(), art);
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
			if (!/^[0-9a-f]{7,40}$/i.test(params.sha)) errors.push(`bad sha: ${params.sha}`);

			if (errors.length) {
				return {
					content: [{ type: "text", text: `BLOCKED\n- ${errors.join("\n- ")}` }],
					details: { ok: false, decision: "BLOCKED", errors },
				};
			}

			state.stages[stage].status = "done";
			state.stages[stage].sha = params.sha;
			state.current = nextStage(stage);
			saveState(state);
			return {
				content: [{ type: "text", text: `APPROVED ${stage} @ ${params.sha.slice(0, 7)}` }],
				details: { ok: true, decision: "APPROVED", stage, sha: params.sha },
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
