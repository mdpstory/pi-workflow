// CLR gating (clrBlocksStage) + stub detection (isStubContent) — Phase 4.
// Run: node --test tests/state.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });

const { clrBlocksStage, isStubContent } = await jiti.import(path.join(root, "lib/state.ts"));

function clr(...entries) {
	return { open: entries.map((e, i) => ({ id: `clr-${i}`, stage: e, raisedBy: "someone" })) };
}

test("clrBlocksStage: no current stage never blocks", () => {
	assert.equal(clrBlocksStage(clr("planning"), null).blocked, false);
});

test("clrBlocksStage: CLR at same stage blocks", () => {
	const r = clrBlocksStage(clr("review"), "review");
	assert.equal(r.blocked, true);
	assert.deepEqual(r.ids, ["clr-0"]);
});

test("clrBlocksStage: CLR at upstream stage blocks", () => {
	const r = clrBlocksStage(clr("planning"), "review");
	assert.equal(r.blocked, true);
});

test("clrBlocksStage: CLR at downstream stage does NOT block", () => {
	const r = clrBlocksStage(clr("documentation"), "planning");
	assert.equal(r.blocked, false);
	assert.deepEqual(r.ids, []);
});

test("clrBlocksStage: mixed open CLRs — only upstream/equal ones counted", () => {
	const r = clrBlocksStage(clr("planning", "documentation", "implementation"), "implementation");
	assert.equal(r.blocked, true);
	assert.deepEqual(r.ids, ["clr-0", "clr-2"]);
});

test("clrBlocksStage: unknown stage name never blocks (defensive)", () => {
	const r = clrBlocksStage(clr("not-a-real-stage"), "review");
	assert.equal(r.blocked, false);
});

test("isStubContent: empty string is a stub", () => {
	assert.equal(isStubContent(""), true);
	assert.equal(isStubContent("   \n  "), true);
});

test("isStubContent: exact wf_init template shape is a stub", () => {
	assert.equal(isStubContent("# Plan\n\n_empty_\n"), true);
	assert.equal(isStubContent("# Plan\n\n_empty_"), true);
});

test("isStubContent: real content quoting the sentinel is NOT a stub", () => {
	const real = "# Plan\n\nThe stub template is `_empty_` and we detect it via regex.\n\nMore content here.\n";
	assert.equal(isStubContent(real), false);
});

test("isStubContent: real, fully-written artifact is not a stub", () => {
	assert.equal(isStubContent("# Plan\n\n## Goals\n- ship it\n"), false);
});
