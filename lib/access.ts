// ---- write/edit gating logic ----
import { ARTIFACT_MDS, ROLE_ALLOW, SHARED_ARTIFACTS } from "./constants.ts";
import { workflowId } from "./identity.ts";

// Returns the path relative to the relevant .workflow/ namespace:
//   "own"    — this session's .workflow/<id>/... (foreign=false)
//   "shared" — .workflow/shared/... (codebase-level artifacts like architecture.md,
//              reachable and non-foreign for every workflow id)
//   foreign  — a *different* workflow id's namespace — cross-namespace writes always denied.
export function wfNamespaceRel(relPath: string): { inside: false } | { inside: true; kind: "own" | "foreign" | "shared"; inner: string } {
	if (!relPath.startsWith(".workflow/")) return { inside: false };
	const rest = relPath.slice(".workflow/".length); // "<id>/..." or "shared/..." or bare (legacy)
	const slash = rest.indexOf("/");
	if (slash === -1) return { inside: true, kind: "own", inner: rest }; // e.g. .workflow/director.lock (legacy, treat as own)
	const id = rest.slice(0, slash);
	const inner = rest.slice(slash + 1);
	if (id === "shared") return { inside: true, kind: "shared", inner };
	return { inside: true, kind: id === workflowId() ? "own" : "foreign", inner };
}

export function isPathAllowedForRole(r: string, relPath: string): { ok: boolean; reason?: string } {
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
