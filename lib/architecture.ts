// ---- architecture.md freshness (git-diff based, no full re-scan) ----
// architecture.md is stamped with a `<!-- generated-at-sha: <sha> -->` marker on its
// first line whenever the Architect writes it. Before making the Architect regenerate
// it, we check whether the tree actually changed since that sha via `git diff --quiet`
// (excluding .workflow/ and node_modules/) — cheap, no need to re-read every file.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { repoRoot } from "./base-paths.ts";
import { artifactPath } from "./paths.ts";

const ARCH_STAMP_RE = /^<!--\s*generated-at-sha:\s*([0-9a-f]{7,40})\s*-->/i;

export function currentGitSha(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot(), encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}
export function readArchStamp(): string | null {
	try {
		const text = fs.readFileSync(artifactPath("architecture.md"), "utf8");
		const m = ARCH_STAMP_RE.exec(text);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}
/** True when architecture.md exists, is stamped, and the repo tree (excluding
 *  .workflow/ and node_modules/) is unchanged since that stamped sha. */
export function isArchitectureFresh(): { fresh: boolean; sha: string | null } {
	const stamped = readArchStamp();
	const head = currentGitSha();
	if (!stamped || !head) return { fresh: false, sha: head };
	if (stamped === head) return { fresh: true, sha: head };
	try {
		execFileSync("git", ["diff", "--quiet", stamped, head, "--", ".", ":!.workflow", ":!node_modules"], { cwd: repoRoot() });
		return { fresh: true, sha: head }; // exit 0 → no diff → still fresh
	} catch {
		return { fresh: false, sha: head }; // non-zero exit → diff found, or git error
	}
}
/** Rewrite/insert the `generated-at-sha` stamp as the first line of architecture.md. */
export function stampArchitecture(sha: string): void {
	const p = artifactPath("architecture.md");
	let text: string;
	try {
		text = fs.readFileSync(p, "utf8");
	} catch {
		return;
	}
	const stampLine = `<!-- generated-at-sha: ${sha} -->`;
	text = ARCH_STAMP_RE.test(text) ? text.replace(ARCH_STAMP_RE, stampLine) : `${stampLine}\n${text}`;
	fs.writeFileSync(p, text);
}
