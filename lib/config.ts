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
	interceptReads?: boolean; // P1-2: substitute fresh knowledge fragments for full read() bodies
}
export function loadConfig(): WfConfig {
	const globalPath = path.join(os.homedir(), ".pi", "agent", "pi-workflow.json");
	const projectPath = path.join(repoRoot(), ".pi", "pi-workflow.json");
	const g = readJson<WfConfig>(globalPath, {});
	const p = readJson<WfConfig>(projectPath, {});
	return { skipStages: p.skipStages ?? g.skipStages, requireApproval: p.requireApproval ?? g.requireApproval, interceptReads: p.interceptReads ?? g.interceptReads };
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
