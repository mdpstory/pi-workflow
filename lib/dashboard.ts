// ---- pi-workflow dashboard widget ----
// Persistent status widget showing role, stage, in-flight subagents, artifacts, and git changes.
// Renders above the editor via ctx.ui.setWidget().
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { role, workflowActive, workflowId } from "./identity.ts";
import { loadState, isStubContent } from "./state.ts";
import { listInflight } from "./inflight.ts";
import { artifactPath, clrIndexPath } from "./paths.ts";
import { ARTIFACT_MDS, STAGES, type Stage } from "./constants.ts";
import { readDiscussion } from "./discussion.ts";
import { repoRoot } from "./base-paths.ts";

// ---- types ----
export interface DashboardTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

// ---- bold helper (theme.bold may or may not exist) ----
function bold(t: DashboardTheme, text: string): string {
	if (t.bold) return t.bold(text);
	return `\x1b[1m${text}\x1b[22m`;
}

// ---- git cache (avoid spawning git every frame) ----
let _gitCache: { text: string; ts: number } | null = null;
const GIT_CACHE_MS = 3000;

function gitSummary(): string {
	const now = Date.now();
	if (_gitCache && now - _gitCache.ts < GIT_CACHE_MS) return _gitCache.text;
	try {
		const root = repoRoot();
		const gitOpts = { cwd: root, encoding: "utf8" as const, timeout: 2000, stdio: ["ignore", "pipe", "pipe"] as const };
		const branch = execSync("git branch --show-current", gitOpts).trim();
		const stat = execSync("git diff --stat -- . ':!.workflow/'", gitOpts).trim();
		const untracked = execSync("git ls-files --others --exclude-standard -- . ':!.workflow/'", gitOpts).trim();
		const parts: string[] = [];
		if (branch) parts.push(`branch:${branch}`);
		if (stat) {
			const lastLine = stat.split("\n").pop() ?? "";
			parts.push(`diff:${lastLine.trim()}`);
		} else {
			parts.push("diff:clean");
		}
		if (untracked) {
			const count = untracked.split("\n").filter(Boolean).length;
			parts.push(`new:${count}`);
		}
		_gitCache = { text: parts.join("  "), ts: now };
		return _gitCache.text;
	} catch {
		_gitCache = { text: "git:N/A", ts: now };
		return "git:N/A";
	}
}

// ---- artifact status ----
interface ArtifactStatus {
	name: string;
	written: boolean;
	stub: boolean;
}

function artifactStatuses(): ArtifactStatus[] {
	const out: ArtifactStatus[] = [];
	for (const md of ARTIFACT_MDS) {
		const abs = artifactPath(md);
		try {
			const content = fs.readFileSync(abs, "utf8");
			const stub = isStubContent(content);
			out.push({ name: md, written: true, stub });
		} catch {
			out.push({ name: md, written: false, stub: true });
		}
	}
	return out;
}

// ---- data collection cache (avoid disk ops every frame) ----
let _dashCache: { data: DashboardData; ts: number } | null = null;
const DASH_CACHE_MS = 500;

// ---- data collection ----
export interface DashboardData {
	role: string;
	workflowId: string;
	active: boolean;
	currentStage: string | null;
	stages: Array<{ name: Stage; status: string }>;
	inflightCount: number;
	inflightDetail: string;
	artifacts: ArtifactStatus[];
	gitText: string;
	discussionCount: number;
	openClrs: string[];
}

export function collectDashboard(): DashboardData {
	const now = Date.now();
	if (_dashCache && now - _dashCache.ts < DASH_CACHE_MS) return _dashCache.data;
	const st = loadState();
	const inflight = listInflight();
	const arts = artifactStatuses();
	const discussion = readDiscussion();

	const inflightDetail = inflight.length
		? inflight
				.map((r) => {
					const mins = Math.max(0, Math.round((Date.now() - Date.parse(r.startedAt)) / 60000));
					return `${r.agent}(${mins}m):${r.task.slice(0, 40)}`;
				})
				.join(" | ")
		: "";

	// Gather open CLRs
	let openClrs: string[] = [];
	try {
		const clr = JSON.parse(fs.readFileSync(clrIndexPath(), "utf8")) as { open?: Array<{ id: string; stage: string }> };
		openClrs = (clr.open ?? []).map((c) => `${c.id}(${c.stage})`);
	} catch {
		// No CLRs yet
	}

	const data: DashboardData = {
		role: role(),
		workflowId: workflowId(),
		active: workflowActive(),
		currentStage: st.current,
		stages: STAGES.map((s) => ({ name: s, status: st.stages[s]?.status ?? "todo" })),
		inflightCount: inflight.length,
		inflightDetail,
		artifacts: arts,
		gitText: gitSummary(),
		discussionCount: discussion.length,
		openClrs,
	};
	_dashCache = { data, ts: Date.now() };
	return data;
}

export function invalidateDashboardCache(): void {
	_dashCache = null;
}

// ---- render ----
function stageIcon(status: string): string {
	switch (status) {
		case "done": return "✓";
		case "in-progress": return "●";
		case "blocked": return "✗";
		default: return "○";
	}
}

function stageFg(status: string): string {
	switch (status) {
		case "done": return "success";
		case "in-progress": return "accent";
		case "blocked": return "error";
		default: return "dim";
	}
}

const STAGE_SHORT: Record<Stage, string> = {
	planning: "plan",
	research: "scout",
	"task-breakdown": "tasks",
	architecture: "arch",
	implementation: "impl",
	review: "review",
	testing: "test",
	documentation: "docs",
};

// Truncate a line with ANSI codes to fit within terminal width.
// Uses simple visual-width approximation — ANSI escapes consume 0 columns.
function truncLine(line: string, width: number): string {
	// Strip ANSI SGR sequences to measure visible width
	const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
	if (stripped.length <= width) return line;
	// Keep as much as possible, ellipsis at end
	let visible = 0;
	let out = "";
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			// Consume escape sequence
			let j = i + 2;
			while (j < line.length && line[j] !== "m") j++;
			out += line.slice(i, j + 1);
			i = j;
			continue;
		}
		if (visible >= width - 1) {
			out += "…";
			break;
		}
		out += line[i];
		visible++;
	}
	return out;
}

export function renderDashboard(d: DashboardData, width: number, theme: DashboardTheme): string[] {
	if (!d.active) return [];

	const t = theme;
	const lines: string[] = [];

	// ---- line 1: role + stage + workflow ----
	const bits1: string[] = [];
	bits1.push(t.fg("accent", `role:${d.role}`));
	if (d.currentStage) {
		const cur = d.stages.find((s) => s.name === d.currentStage);
		const curIcon = cur ? stageIcon(cur.status) : "";
		bits1.push(t.fg("accent", `stage:${curIcon}${d.currentStage}`));
	} else {
		bits1.push(t.fg("dim", "stage:—"));
	}
	bits1.push(t.fg("muted", `wf:${d.workflowId.slice(0, 8)}`));
	if (d.openClrs.length) bits1.push(t.fg("warning", `CLR:${d.openClrs.length}`));
	if (d.discussionCount > 0) bits1.push(t.fg("muted", `disc:${d.discussionCount}`));
	lines.push(bits1.join(" "));

	// ---- line 2: stage pipeline ----
	const stageBits: string[] = [];
	for (const s of d.stages) {
		const icon = stageIcon(s.status);
		const fg = stageFg(s.status);
		const label = STAGE_SHORT[s.name];
		if (s.status === "in-progress") {
			stageBits.push(t.fg(fg, bold(t, `${icon}${label}`)));
		} else {
			stageBits.push(t.fg(fg, `${icon}${label}`));
		}
	}
	lines.push(stageBits.join(t.fg("dim", "|")));

	// ---- line 3: artifacts ----
	const artBits: string[] = [];
	const written = d.artifacts.filter((a) => a.written && !a.stub);
	const stubs = d.artifacts.filter((a) => a.written && a.stub);
	if (written.length) {
		artBits.push(t.fg("success", `arts:${written.length}`) + t.fg("muted", `(${written.map((a) => a.name.replace(".md", "")).join(",")})`));
	}
	if (stubs.length) {
		artBits.push(t.fg("dim", `stubs:${stubs.map((a) => a.name.replace(".md", "")).join(",")}`));
	}
	if (artBits.length) {
		lines.push(artBits.join(" "));
	} else {
		lines.push(t.fg("dim", "arts: none yet"));
	}

	// ---- line 4: in-flight ----
	if (d.inflightCount > 0) {
		lines.push(t.fg("accent", `sub:${d.inflightCount} `) + t.fg("dim", d.inflightDetail));
	} else {
		lines.push(t.fg("dim", "sub: none"));
	}

	// ---- line 5: git ----
	lines.push(t.fg("dim", d.gitText));

	// Truncate all lines to fit terminal width
	return lines.map((l) => truncLine(l, width));
}
