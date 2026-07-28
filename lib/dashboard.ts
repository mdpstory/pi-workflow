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
import { truncLine } from "./trunc.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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

// ---- render helpers (exported for overlay component) ----
export function stageIcon(status: string): string {
	switch (status) {
		case "done": return "✓";
		case "in-progress": return "●";
		case "blocked": return "✗";
		default: return "○";
	}
}

export function stageFg(status: string): string {
	switch (status) {
		case "done": return "success";
		case "in-progress": return "accent";
		case "blocked": return "error";
		default: return "dim";
	}
}

export const STAGE_SHORT: Record<Stage, string> = {
	planning: "plan",
	research: "scout",
	"task-breakdown": "tasks",
	architecture: "arch",
	implementation: "impl",
	review: "review",
	testing: "test",
	documentation: "docs",
};



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

// ---- compact git (parse diff-stat into short form) ----
function gitCompact(): string {
	try {
		const root = repoRoot();
		const gitOpts = { cwd: root, encoding: "utf8" as const, timeout: 2000, stdio: ["ignore", "pipe", "pipe"] as const };
		const branch = execSync("git branch --show-current", gitOpts).trim();
		const stat = execSync("git diff --stat -- . ':!.workflow/'", gitOpts).trim();
		if (!stat) return branch || "git";
		// Parse "2 files changed, 7 insertions(+), 3 deletions(-)"
		const ins = stat.match(/(\d+) insertion/);
		const del = stat.match(/(\d+) deletion/);
		const files = stat.match(/^(\d+) file/);
		const parts: string[] = [];
		if (branch) parts.push(branch);
		const changes: string[] = [];
		if (files) changes.push(`${files[1]}f`);
		if (ins) changes.push(`+${ins[1]}`);
		if (del) changes.push(`-${del[1]}`);
		if (changes.length) parts.push(changes.join(","));
		return parts.join(":") || "git";
	} catch {
		return "git:N/A";
	}
}

// ---- compact 1-line widget ----
export function renderCompactDashboard(d: DashboardData, width: number, theme: DashboardTheme): string[] {
	if (!d.active) return [];

	const t = theme;
	const bits: string[] = [];

	// overall status indicator
	const allDone = d.stages.every((s) => s.status === "done");
	const anyBlocked = d.stages.some((s) => s.status === "blocked");
	const anyInProgress = d.stages.some((s) => s.status === "in-progress");
	if (anyBlocked) bits.push(t.fg("error", "✗"));
	else if (anyInProgress) bits.push(t.fg("accent", "●"));
	else if (allDone) bits.push(t.fg("success", "✓"));
	else bits.push(t.fg("dim", "○"));

	bits.push(t.fg("accent", d.role.slice(0, 9)));
	bits.push(t.fg("muted", `wf:${d.workflowId.slice(0, 8)}`));

	// stage pipeline (compact)
	const pipeBits: string[] = [];
	for (const s of d.stages) {
		const icon = stageIcon(s.status);
		const fg = stageFg(s.status);
		const label = STAGE_SHORT[s.name];
		if (s.status === "in-progress") {
			pipeBits.push(t.fg(fg, bold(t, `${icon}${label}`)));
		} else {
			pipeBits.push(t.fg(fg, `${icon}${label}`));
		}
	}
	bits.push(pipeBits.join(t.fg("dim", "|")));

	// counts
	const written = d.artifacts.filter((a) => a.written && !a.stub).length;
	const stubs = d.artifacts.filter((a) => a.written && a.stub).length;
	bits.push(t.fg(written ? "success" : "dim", `arts:${written}`));
	if (stubs) bits.push(t.fg("dim", `+${stubs}`));
	if (d.inflightCount) bits.push(t.fg("accent", `sub:${d.inflightCount}`));
	if (d.discussionCount) bits.push(t.fg("muted", `disc:${d.discussionCount}`));
	if (d.openClrs.length) bits.push(t.fg("warning", `CLR:${d.openClrs.length}`));

	// git
	bits.push(t.fg("dim", gitCompact()));

	const line = bits.join("  ");
	return [truncLine(line, width)];
}

// ---- overlay panel (rich boxed panel for ctx.ui.custom overlay) ----

/** Pad a styled string to `target` visible width with trailing spaces. */
function padVis(s: string, target: number): string {
	const vw = visibleWidth(s);
	if (vw >= target) return s;
	return s + " ".repeat(target - vw);
}

/** Wrap a line with border: `│ content │`, padding content to inner width. */
function borderLine(content: string, inner: number, theme: DashboardTheme): string {
	const t = theme;
	return t.fg("borderAccent", `│ `) + padVis(content, inner) + t.fg("borderAccent", ` │`);
}

/** Build a horizontal border line: ╭──...──╮, ├──...──┤, ╰──...──╯ */
function hLine(left: string, inner: number, right: string, theme: DashboardTheme): string {
	return theme.fg("borderAccent", left + "─".repeat(inner + 2) + right);
}

export function renderOverlayPanel(d: DashboardData, width: number, theme: DashboardTheme): string[] {
	const t = theme;
	const inner = Math.max(20, width - 4);
	const lines: string[] = [];

	// top border
	lines.push(hLine("╭", inner, "╮", t));

	// title
	const title = "Workflow Dashboard";
	const titlePad = Math.max(0, Math.floor((inner - title.length) / 2));
	lines.push(borderLine(" ".repeat(titlePad) + t.fg("accent", bold(t, title)), inner, t));
	lines.push(hLine("├", inner, "┤", t));

	// row 1: role + stage
	const stageStr = d.currentStage
		? `${stageIcon(d.stages.find((s) => s.name === d.currentStage)?.status ?? "todo")}${d.currentStage}`
		: "—";
	lines.push(borderLine(
		t.fg("accent", bold(t, d.role)) + t.fg("muted", `  ·  stage: ${stageStr}  ·  disc: ${d.discussionCount}`),
		inner, t,
	));

	// row 2: wf + CLR
	lines.push(borderLine(
		t.fg("muted", `wf: ${d.workflowId.slice(0, 8)}`) +
		(d.openClrs.length ? t.fg("warning", `  CLR: ${d.openClrs.length} open`) : t.fg("dim", "  CLR: none")),
		inner, t,
	));

	// separator
	lines.push(borderLine("", inner, t));

	// pipeline section
	lines.push(borderLine(t.fg("accent", bold(t, "Pipeline")), inner, t));
	// Build pipe tokens and wrap across lines
	const pipeBits: string[] = [];
	for (const s of d.stages) {
		const icon = stageIcon(s.status);
		const fg = stageFg(s.status);
		const label = STAGE_SHORT[s.name];
		const styled = s.status === "in-progress"
			? t.fg(fg, bold(t, `${icon}${label}`))
			: t.fg(fg, `${icon}${label}`);
		pipeBits.push(styled);
	}
	const pipeLines: string[] = [];
	let cur = "";
	for (const seg of pipeBits) {
		const test = cur ? cur + " " + seg : seg;
		if (visibleWidth(test) > inner) {
			if (cur) pipeLines.push(cur);
			cur = seg;
		} else {
			cur = test;
		}
	}
	if (cur) pipeLines.push(cur);
	for (const pl of pipeLines) {
		lines.push(borderLine(pl, inner, t));
	}

	// separator
	lines.push(borderLine("", inner, t));

	// artifacts section
	const written = d.artifacts.filter((a) => a.written && !a.stub);
	const stubs = d.artifacts.filter((a) => a.written && a.stub);
	const missing = d.artifacts.filter((a) => !a.written);
	lines.push(borderLine(
		t.fg("accent", bold(t, "Artifacts")) + t.fg("muted", `  (${written.length} real, ${stubs.length} stub, ${missing.length} missing)`),
		inner, t,
	));
	for (const a of written) {
		lines.push(borderLine(`  ${t.fg("success", "✓")} ${t.fg("muted", a.name)}`, inner, t));
	}
	const showStubs = stubs.slice(0, 5);
	for (const a of showStubs) {
		lines.push(borderLine(`  ${t.fg("dim", "○")} ${t.fg("dim", a.name)}`, inner, t));
	}
	if (stubs.length > 5) {
		lines.push(borderLine(`  ${t.fg("dim", `... +${stubs.length - 5} more stub files`)}`, inner, t));
	}

	// separator
	lines.push(borderLine("", inner, t));

	// git
	lines.push(borderLine(t.fg("muted", `Git: ${d.gitText}`), inner, t));

	// in-flight
	if (d.inflightCount > 0) {
		lines.push(borderLine(t.fg("accent", `In-flight: ${d.inflightCount} subagent(s)`), inner, t));
		lines.push(borderLine(t.fg("dim", `  ${truncLine(d.inflightDetail, inner - 2)}`), inner, t));
	} else {
		lines.push(borderLine(t.fg("dim", "In-flight: none"), inner, t));
	}

	// footer
	lines.push(borderLine("", inner, t));
	const escHint = "[ Esc to close ]";
	lines.push(borderLine(t.fg("dim", escHint), inner, t));
	lines.push(hLine("╰", inner, "╯", t));

	return lines;
}
