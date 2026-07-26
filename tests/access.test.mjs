// Access-control matrix: isPathAllowedForRole across roles x path shapes (Phase 4).
// Run: node --test tests/access.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });

process.env.PI_WORKFLOW_ID = "wf-test-access";
const { isPathAllowedForRole } = await jiti.import(path.join(root, "lib/access.ts"));

const ID = "wf-test-access";

function allowed(role, p) {
	return isPathAllowedForRole(role, p).ok;
}

test("own artifact: owning role allowed, others denied", () => {
	assert.equal(allowed("planner", `.workflow/${ID}/artifacts/plan.md`), true);
	assert.equal(allowed("scout", `.workflow/${ID}/artifacts/plan.md`), false);
	assert.equal(allowed("director", `.workflow/${ID}/artifacts/plan.md`), false);
	assert.equal(allowed("reviewer", `.workflow/${ID}/artifacts/review.md`), true);
	assert.equal(allowed("qa", `.workflow/${ID}/artifacts/review.md`), false);
});

test("foreign namespace: always denied regardless of role", () => {
	assert.equal(allowed("director", ".workflow/some-other-id/artifacts/decisions.md"), false);
	assert.equal(allowed("planner", ".workflow/some-other-id/artifacts/plan.md"), false);
	assert.equal(allowed("engineer", ".workflow/some-other-id/state.json"), false);
});

test("shared artifact: only architect writes, director hard-blocked", () => {
	assert.equal(allowed("architect", ".workflow/shared/artifacts/architecture.md"), true);
	assert.equal(allowed("director", ".workflow/shared/artifacts/architecture.md"), false);
	assert.equal(allowed("engineer", ".workflow/shared/artifacts/architecture.md"), false);
});

test("shared non-artifact filename rejected", () => {
	assert.equal(allowed("architect", ".workflow/shared/artifacts/not-a-real-artifact.md"), false);
	assert.equal(allowed("architect", ".workflow/shared/random.json"), false);
});

test("state file (non-artifact): director only", () => {
	assert.equal(allowed("director", `.workflow/${ID}/state.json`), true);
	assert.equal(allowed("director", `.workflow/${ID}/clr-index.json`), true);
	assert.equal(allowed("director", `.workflow/${ID}/director.lock`), true);
	assert.equal(allowed("planner", `.workflow/${ID}/state.json`), false);
	assert.equal(allowed("engineer", `.workflow/${ID}/bus/director.jsonl`), false);
});

test("clarifications.md: every role in ROLE_ALLOW may write it", () => {
	for (const role of ["director", "planner", "scout", "architect", "engineer", "reviewer", "qa", "documenter"]) {
		assert.equal(allowed(role, `.workflow/${ID}/artifacts/clarifications.md`), true, `${role} should write clarifications.md`);
	}
});

test("source file: engineer/qa/documenter allowed, others denied", () => {
	assert.equal(allowed("engineer", "src/foo.ts"), true);
	assert.equal(allowed("qa", "tests/foo.test.ts"), true);
	assert.equal(allowed("documenter", "docs/guide.md"), true);
	assert.equal(allowed("documenter", "README.md"), true);
	assert.equal(allowed("planner", "src/foo.ts"), false);
	assert.equal(allowed("scout", "src/foo.ts"), false);
	assert.equal(allowed("architect", "src/foo.ts"), false);
	assert.equal(allowed("director", "src/foo.ts"), false);
	assert.equal(allowed("reviewer", "src/foo.ts"), false);
});

test("qa: any non-artifact source is allowed by the default engineer/qa/documenter branch", () => {
	// Note: the qa-specific patterns in ROLE_ALLOW.qa (tests?/, .test., .spec.) only govern
	// writes *inside* .workflow/<id>/artifacts/ (e.g. test-report.md neighbors); the plain
	// source branch in isPathAllowedForRole grants qa (like engineer/documenter) blanket
	// access to any non-artifact path, not just test files. Documented here so a future
	// tightening (source scoped to actual test-file patterns) has a pinned baseline to diff.
	assert.equal(allowed("qa", "tests/foo.test.ts"), true);
	assert.equal(allowed("qa", "foo.spec.ts"), true);
	assert.equal(allowed("qa", "src/foo.ts"), true);
});

test("documenter: docs/ and README.md allowed; blanket source access too (same default branch)", () => {
	assert.equal(allowed("documenter", "docs/x.md"), true);
	assert.equal(allowed("documenter", "README.md"), true);
	assert.equal(allowed("documenter", "src/foo.ts"), true);
});

test("unknown/unassigned role: always denied", () => {
	assert.equal(allowed("unassigned", "src/foo.ts"), false);
	assert.equal(allowed("bogus-role", `.workflow/${ID}/artifacts/plan.md`), false);
});

test("path traversal inside namespace resolves via inner string, still gated normally", () => {
	// wfNamespaceRel does not itself resolve ".."; isPathAllowedForRole just pattern-matches
	// the inner string. A traversal attempt inside the artifacts/ prefix still fails the
	// per-role filename allowlist unless it happens to match an owned artifact name exactly.
	assert.equal(allowed("planner", `.workflow/${ID}/artifacts/../../../etc/passwd`), false);
});
