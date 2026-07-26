// ---- shared constants ----

export const STAGES = [
	"planning",
	"research",
	"task-breakdown",
	"architecture",
	"implementation",
	"review",
	"testing",
	"documentation",
] as const;
export type Stage = (typeof STAGES)[number];

export const ARTIFACT_FOR_STAGE: Record<Stage, string[]> = {
	planning: ["plan.md", "tasks.md"],
	research: ["research.md"],
	"task-breakdown": ["tasks.md"], // written by planner, never by director
	architecture: ["architecture.md"],
	implementation: [], // source code; knowledge fragments, not an artifact
	review: ["review.md"],
	testing: ["test-report.md"],
	documentation: ["changelog.md"],
};

// Maps each stage to the role that should execute it.
// Used by wf_stage_start to advise the director which role to delegate to.
export const ROLE_FOR_STAGE: Record<Stage, string> = {
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
export const ROLE_ALLOW: Record<string, RegExp[]> = {
	// NOTE: patterns are matched against the path *inside* the current session's
	// .workflow/<id>/ namespace (prefix already stripped) — see isPathAllowedForRole.
	// Director's non-artifact state files (state.json, clr-index.json, director.lock) are
	// handled by a separate "director only" branch in isPathAllowedForRole and don't need a
	// pattern here. This list therefore only needs to cover the *artifacts* director is
	// actually allowed to write directly — must NOT be a wildcard, or director could write
	// plan.md/research.md/review.md/test-report.md/changelog.md, which are supposed to be
	// hard-blocked (owned by Planner/Scout/Reviewer/QA/Documenter respectively).
	// Director writes NO stage artifact — only rulings + CLR resolutions. tasks.md belongs to
	// the planner (task-breakdown stage is dispatched, not self-served).
	director: [/^artifacts\/decisions\.md$/, /^artifacts\/clarifications\.md$/],
	planner: [/^artifacts\/plan\.md$/, /^artifacts\/tasks\.md$/, /^artifacts\/clarifications\.md$/],
	scout: [/^artifacts\/research\.md$/, /^artifacts\/clarifications\.md$/],
	// (P1-6) decisions.md is the director's rulings log — both the director skill and the
	// artifact-ownership table call it director-owned, but it was also in this allowlist,
	// letting an architect overwrite director rulings. design-decisions.md is architect's own
	// artifact for design rationale instead.
	architect: [/^artifacts\/architecture\.md$/, /^artifacts\/design-decisions\.md$/, /^artifacts\/clarifications\.md$/],
	engineer: [/^artifacts\/clarifications\.md$/], // + source (default allow below)
	reviewer: [/^artifacts\/review\.md$/, /^artifacts\/clarifications\.md$/],
	qa: [/^artifacts\/test-report\.md$/, /^artifacts\/clarifications\.md$/, /(^|\/)tests?\//, /\.test\./, /\.spec\./],
	documenter: [/^artifacts\/changelog\.md$/, /^docs\//, /^README\.md$/, /^artifacts\/clarifications\.md$/],
};

// Artifact md files. Anything not in this set is treated as "source" and allowed for engineer.
export const ARTIFACT_MDS = new Set([
	"plan.md",
	"tasks.md",
	"research.md",
	"architecture.md",
	"decisions.md",
	"design-decisions.md",
	"clarifications.md",
	"review.md",
	"test-report.md",
	"changelog.md",
]);

// Artifacts that live at .workflow/shared/artifacts/ instead of per-workflow.
// These are properties of the codebase, not of an individual task.
export const SHARED_ARTIFACTS = new Set(["architecture.md"]);

export function stageIndex(s: string): number {
	return STAGES.indexOf(s as Stage);
}
export function nextStage(s: Stage): Stage | null {
	const i = stageIndex(s);
	return i < STAGES.length - 1 ? STAGES[i + 1] : null;
}
