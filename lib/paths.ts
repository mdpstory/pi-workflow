// ---- per-workflow paths (state, artifacts, lock, bus, knowledge) ----
//
// State: .workflow/<id>/state.json, .workflow/<id>/clr-index.json
// Artifacts (per-workflow, .workflow/<id>/artifacts/): plan.md, tasks.md, research.md,
//            decisions.md, clarifications.md, review.md, test-report.md, changelog.md
// Shared artifact (.workflow/shared/artifacts/, one copy for the whole repo across all
//            parallel workflow ids — architecture is a codebase property, not a task
//            property): architecture.md
// Knowledge (P1): per-source-file immutable fragments, .workflow/shared/knowledge/ or
//            .workflow/<id>/knowledge/, see wf_knowledge_put/get.
// Bus (P2): .workflow/<id>/bus/<role>.jsonl, see wf_msg_post/poll/wf_bus_digest.
import * as path from "node:path";
import { repoRoot, wfRoot } from "./base-paths.ts";
import { SHARED_ARTIFACTS } from "./constants.ts";
import { workflowId } from "./identity.ts";

export { repoRoot, wfRoot };

export function wfDir(): string {
	return path.join(wfRoot(), workflowId());
}
export function artifactsDir(): string {
	return path.join(wfDir(), "artifacts");
}
export function sharedArtifactsDir(): string {
	return path.join(wfRoot(), "shared", "artifacts");
}
/** Resolve the actual path for an artifact, routing shared ones to .workflow/shared/artifacts/. */
export function artifactPath(filename: string): string {
	return SHARED_ARTIFACTS.has(filename)
		? path.join(sharedArtifactsDir(), filename)
		: path.join(artifactsDir(), filename);
}
export function statePath(): string {
	return path.join(wfDir(), "state.json");
}
export function clrIndexPath(): string {
	return path.join(wfDir(), "clr-index.json");
}
export function lockPath(): string {
	return path.join(wfDir(), "director.lock");
}
export function busDir(): string {
	return path.join(wfDir(), "bus");
}
export function busFile(target: string): string {
	return path.join(busDir(), `${target}.jsonl`);
}
export function relFromRepo(p: string): string {
	const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot(), p);
	return path.relative(repoRoot(), abs).replaceAll("\\", "/");
}

// ---- knowledge fragment storage paths (P1-1) ----
export function sanitizeFilePath(file: string): string {
	return file
		.replace(/^\.\/?/, "")
		.replace(/\.\./g, "_")
		.replace(/[\\/]/g, "__")
		.replace(/[^a-zA-Z0-9._-]/g, "_");
}
export function knowledgeDir(file: string, scope: "general" | "task"): string {
	const base = scope === "general" ? path.join(wfRoot(), "shared", "knowledge") : path.join(wfDir(), "knowledge");
	return path.join(base, sanitizeFilePath(file));
}
