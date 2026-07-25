// ---- repo-root and .workflow/ root (no dependency on session identity) ----
import * as path from "node:path";

export function repoRoot(): string {
	return process.cwd();
}
export function wfRoot(): string {
	return path.join(repoRoot(), ".workflow");
}
