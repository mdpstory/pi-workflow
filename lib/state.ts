// ---- workflow state + CLR index ----
import { STAGES, type Stage, stageIndex } from "./constants.ts";
import { readJson, writeJson } from "./io.ts";
import { clrIndexPath, statePath } from "./paths.ts";

export interface RetryRec {
	bumps: number; // failed attempts since last ruling
	ruled: number; // director rulings issued on this key
}
export interface PendingApproval {
	stage: Stage;
	sha: string;
	summary: string;
}
export interface WfState {
	stages: Record<Stage, { status: "todo" | "in-progress" | "done" | "blocked"; sha?: string; retries?: number }>;
	current: Stage | null;
	rulings: Record<string, RetryRec>; // CLR-id or defect-key → counters
	pendingApproval?: PendingApproval | null;
}

export interface ClrIndex {
	open: { id: string; stage: string; raisedBy: string }[];
}

export function loadState(): WfState {
	const empty: WfState = {
		stages: Object.fromEntries(STAGES.map((s) => [s, { status: "todo" }])) as WfState["stages"],
		current: null,
		rulings: {},
		pendingApproval: null,
	};
	return readJson(statePath(), empty);
}
export function saveState(state: WfState): void {
	writeJson(statePath(), state);
}
export function loadClr(): ClrIndex {
	return readJson(clrIndexPath(), { open: [] });
}

// (C4) Exact-shape stub check, not "includes _empty_ anywhere" — the old substring check
// mis-flagged any artifact that merely *quoted* the sentinel token as still being a stub.
// The stub template wf_init writes is exactly `# <title>\n\n_empty_\n`; match that shape.
const STUB_RE = /^#\s.*\n\n_empty_\s*$/;
export function isStubContent(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed === "") return true;
	return STUB_RE.test(trimmed);
}

export function clrBlocksStage(clr: ClrIndex, currentStage: Stage | null): { blocked: boolean; ids: string[] } {
	if (!currentStage) return { blocked: false, ids: [] };
	const curIdx = stageIndex(currentStage);
	const hits = clr.open.filter((c) => {
		const idx = stageIndex(c.stage);
		return idx === -1 ? false : idx <= curIdx;
	});
	return { blocked: hits.length > 0, ids: hits.map((c) => c.id) };
}
