// Architecture freshness (git-diff based) — stage machine's architecture-skip check (Phase 4).
// Run: node --test tests/architecture.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });

function git(cwd, ...args) {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("isArchitectureFresh: unstamped/missing file is never fresh", async () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-arch-"));
	const cwd = process.cwd();
	process.chdir(sandbox);
	try {
		git(sandbox, "init", "-q");
		git(sandbox, "config", "user.email", "t@t.co");
		git(sandbox, "config", "user.name", "t");
		fs.writeFileSync("f.txt", "1");
		git(sandbox, "add", ".");
		git(sandbox, "commit", "-q", "-m", "init");

		const { isArchitectureFresh } = await jiti.import(path.join(root, "lib/architecture.ts"));
		const r = isArchitectureFresh();
		assert.equal(r.fresh, false, "no architecture.md at all → not fresh");
	} finally {
		process.chdir(cwd);
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("isArchitectureFresh: fresh right after stamping, stale after a real tree change, fresh again after restamp", async () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-arch-"));
	const cwd = process.cwd();
	process.chdir(sandbox);
	try {
		git(sandbox, "init", "-q");
		git(sandbox, "config", "user.email", "t@t.co");
		git(sandbox, "config", "user.name", "t");
		fs.writeFileSync("f.txt", "1");
		git(sandbox, "add", ".");
		git(sandbox, "commit", "-q", "-m", "init");

		const { isArchitectureFresh, stampArchitecture, currentGitSha } = await jiti.import(path.join(root, "lib/architecture.ts"));
		const { artifactPath } = await jiti.import(path.join(root, "lib/paths.ts"));

		const archPath = artifactPath("architecture.md");
		fs.mkdirSync(path.dirname(archPath), { recursive: true });
		fs.writeFileSync(archPath, "# Architecture\n\nsome content\n");

		const sha1 = currentGitSha();
		stampArchitecture(sha1);
		assert.equal(isArchitectureFresh().fresh, true, "just-stamped at current HEAD → fresh");

		// Real tree change (excluding .workflow/) → stale.
		fs.writeFileSync("f.txt", "2");
		git(sandbox, "add", ".");
		git(sandbox, "commit", "-q", "-m", "change");
		assert.equal(isArchitectureFresh().fresh, false, "tree changed since stamp → stale");

		// Restamp at new HEAD → fresh again.
		const sha2 = currentGitSha();
		assert.notEqual(sha1, sha2);
		stampArchitecture(sha2);
		assert.equal(isArchitectureFresh().fresh, true, "restamped at new HEAD → fresh");
	} finally {
		process.chdir(cwd);
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("isArchitectureFresh: a .workflow/-only change does not invalidate the stamp", async () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wf-arch-"));
	const cwd = process.cwd();
	process.chdir(sandbox);
	try {
		git(sandbox, "init", "-q");
		git(sandbox, "config", "user.email", "t@t.co");
		git(sandbox, "config", "user.name", "t");
		fs.writeFileSync("f.txt", "1");
		git(sandbox, "add", ".");
		git(sandbox, "commit", "-q", "-m", "init");

		const { isArchitectureFresh, stampArchitecture, currentGitSha } = await jiti.import(path.join(root, "lib/architecture.ts"));
		const { artifactPath } = await jiti.import(path.join(root, "lib/paths.ts"));

		const archPath = artifactPath("architecture.md");
		fs.mkdirSync(path.dirname(archPath), { recursive: true });
		fs.writeFileSync(archPath, "# Architecture\n\nsome content\n");
		stampArchitecture(currentGitSha());

		// Simulate unrelated .workflow/ churn tracked by git (not gitignored in this sandbox repo).
		fs.mkdirSync(".workflow/some-id/artifacts", { recursive: true });
		fs.writeFileSync(".workflow/some-id/artifacts/plan.md", "# Plan\n\n_empty_\n");
		git(sandbox, "add", ".");
		git(sandbox, "commit", "-q", "-m", ".workflow churn");

		assert.equal(isArchitectureFresh().fresh, true, ".workflow/ changes are excluded from the diff check");
	} finally {
		process.chdir(cwd);
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});
