// ---- settings.json config (project overrides global) ----
// Static per-repo settings only (NOT per-process identity like role, which stays env/claim
// based so concurrent director/planner/engineer subagents don't collapse onto one shared
// value). Project: <repo>/.pi/pi-workflow.json   Global: ~/.pi/agent/pi-workflow.json
// Shape: { "skipStages": ["review", "testing"], "requireApproval": ["architecture"], "interceptReads": true }
import * as os from "node:os";
import * as path from "node:path";
import { repoRoot } from "./base-paths.ts";
import { STAGES, type Stage } from "./constants.ts";
import { readJson } from "./io.ts";

export interface WfConfig {
	skipStages?: string[];
	requireApproval?: string[];
	requirePreApproval?: string[]; // stages that need user approval BEFORE next stage starts
	interceptReads?: boolean; // P1-2: substitute fresh knowledge fragments for full read() bodies
	autoResolveGateInUi?: boolean; // Fix D: let the TUI dialog resolve a human gate inline (default false)
	requireDiscussionBeforeImpl?: boolean; // Fix B: block implementation until wf_discuss ran (default true)
	showDashboard?: boolean; // show workflow dashboard widget above editor (default true)
}
export function loadConfig(): WfConfig {
	const globalPath = path.join(os.homedir(), ".pi", "agent", "pi-workflow.json");
	const projectPath = path.join(repoRoot(), ".pi", "pi-workflow.json");
	const g = readJson<WfConfig>(globalPath, {});
	const p = readJson<WfConfig>(projectPath, {});
	return {
		skipStages: p.skipStages ?? g.skipStages,
		requireApproval: p.requireApproval ?? g.requireApproval,
		requirePreApproval: p.requirePreApproval ?? g.requirePreApproval,
		// P0-2: default true — dedup should not depend on agents remembering to opt in.
		// Escape hatch: read with offset/limit always forces raw source; .workflow/ paths exempt.
		interceptReads: p.interceptReads ?? g.interceptReads ?? true,
		// Fix D: default false — the TUI dialog is advisory/display-only, the director's
		// wf_approve/wf_continue call stays authoritative, so the two gate paths cannot
		// double-fire and race each other. Set true to restore one-click inline resolve.
		autoResolveGateInUi: p.autoResolveGateInUi ?? g.autoResolveGateInUi ?? false,
		// Fix B: default true — director must actually discuss with the user before code lands.
		requireDiscussionBeforeImpl: p.requireDiscussionBeforeImpl ?? g.requireDiscussionBeforeImpl ?? true,
		showDashboard: p.showDashboard ?? g.showDashboard ?? true,
	};
}
export function autoResolveGateInUi(): boolean {
	return loadConfig().autoResolveGateInUi === true;
}
export function requireDiscussionBeforeImpl(): boolean {
	return loadConfig().requireDiscussionBeforeImpl !== false;
}
export function showDashboard(): boolean {
	return loadConfig().showDashboard !== false;
}

// Stages to auto-skip by default, via skipStages in .pi/pi-workflow.json (or
// ~/.pi/agent/pi-workflow.json). wf_stage_start chains through them automatically;
// wf_stage_complete waives their artifact requirement too.
export function skipStagesSet(): Set<Stage> {
	const names = (loadConfig().skipStages ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
	return new Set(names.filter((n): n is Stage => (STAGES as readonly string[]).includes(n)));
}
export function requireApprovalSet(): Set<Stage> {
	const names = (loadConfig().requireApproval ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
	return new Set(names.filter((n): n is Stage => (STAGES as readonly string[]).includes(n)));
}
export function requirePreApprovalSet(): Set<Stage> {
	const names = (loadConfig().requirePreApproval ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
	return new Set(names.filter((n): n is Stage => (STAGES as readonly string[]).includes(n)));
}
