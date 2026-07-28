// Tests for live view subagent write feature (extractPartialStringField, simpleDiffLines, etc.)
import assert from "node:assert";
import { describe, it } from "node:test";

// Direct import of format helpers via jiti — no sandbox needed for pure functions.
import { createJiti } from "jiti";
import * as os from "node:os";
import * as path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const formatModule = await jiti.import(
	new URL("../subagent/format.ts", import.meta.url).pathname,
);

const {
	extractPartialStringField,
	simpleDiffLines,
	langForPath,
	formatToolCall,
} = formatModule;

// Stub theme for formatToolCall tests
const noopFg = (_color, text) => text;

describe("extractPartialStringField", () => {
	it("extracts value from compact JSON", () => {
		const raw = '{"file_path":"/tmp/test.ts","content":"hello world"}';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello world");
		assert.strictEqual(extractPartialStringField(raw, "file_path"), "/tmp/test.ts");
	});

	it("handles streaming partial JSON (no closing brace)", () => {
		const raw = '{"file_path":"/tmp/test.ts","content":"hello world';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello world");
	});

	it("handles escaped characters in value", () => {
		const raw = '{"content":"line1\\nline2\\tindented\\"quoted\\""}';
		assert.strictEqual(extractPartialStringField(raw, "content"), 'line1\nline2\tindented"quoted"');
	});

	it("handles unicode escapes", () => {
		const raw = '{"content":"hello\\u0020world"}';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello world");
	});

	it("tolerates whitespace around colon (Fix 3)", () => {
		const raw = '{"content" : "hello world"}';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello world");
	});

	it("tolerates tabs and newlines around colon", () => {
		const raw = '{"content"\t:\n"hello"}';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello");
	});

	it("returns undefined for missing field", () => {
		const raw = '{"other":"value"}';
		assert.strictEqual(extractPartialStringField(raw, "missing"), undefined);
	});

	it("handles empty value", () => {
		const raw = '{"content":""}';
		assert.strictEqual(extractPartialStringField(raw, "content"), "");
	});

	it("returns undefined when colon missing after key", () => {
		const raw = '"content" not a value';
		assert.strictEqual(extractPartialStringField(raw, "content"), undefined);
	});

	it("returns undefined when value is not a string (number)", () => {
		// Number value after colon — no opening quote
		const raw = '{"count":42}';
		assert.strictEqual(extractPartialStringField(raw, "count"), undefined);
	});

	it("stops at dangling escape at buffer end", () => {
		const raw = '{"content":"hello\\';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello");
	});

	it("handles incomplete unicode escape", () => {
		const raw = '{"content":"hello\\u00';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello");
	});

	it("extracts nested field from edit-style JSON", () => {
		const raw = '{"edits":[{"oldText":"foo","newText":"bar"}]}';
		assert.strictEqual(extractPartialStringField(raw, "newText"), "bar");
	});

	it("finds first occurrence in ambiguous JSON", () => {
		// "content" appears as part of file_path but is followed by a slash, not colon
		const raw = '{"file_path":"/tmp/content-file.txt","content":"hello"}';
		assert.strictEqual(extractPartialStringField(raw, "content"), "hello");
	});
});

describe("simpleDiffLines", () => {
	it("returns empty for identical text", () => {
		const lines = simpleDiffLines("abc\ndef", "abc\ndef");
		assert.deepStrictEqual(lines, []);
	});

	it("shows additions", () => {
		const lines = simpleDiffLines("abc", "abc\ndef");
		assert.deepStrictEqual(lines, ["+ def"]);
	});

	it("shows deletions", () => {
		const lines = simpleDiffLines("abc\ndef\nghi", "abc\nghi");
		assert.deepStrictEqual(lines, ["- def"]);
	});

	it("shows mixed changes", () => {
		const lines = simpleDiffLines("abc\ndef\nghi", "abc\nxyz\nghi");
		assert.deepStrictEqual(lines, ["- def", "+ xyz"]);
	});

	it("handles multi-line blocks", () => {
		const lines = simpleDiffLines("a\nb\nc\nd", "a\nx\ny\nd");
		assert.deepStrictEqual(lines, ["- b", "- c", "+ x", "+ y"]);
	});

	it("handles prefix-only changes", () => {
		const lines = simpleDiffLines("hello world", "hello there");
		assert.deepStrictEqual(lines, ["- hello world", "+ hello there"]);
	});

	it("handles empty old text", () => {
		const lines = simpleDiffLines("", "new content");
		assert.deepStrictEqual(lines, ["+ new content"]);
	});

	it("handles empty new text", () => {
		const lines = simpleDiffLines("old content", "");
		assert.deepStrictEqual(lines, ["- old content"]);
	});
});

describe("langForPath", () => {
	it("returns typescript for .ts", () => {
		assert.strictEqual(langForPath("file.ts"), "typescript");
	});
	it("returns javascript for .js", () => {
		assert.strictEqual(langForPath("file.js"), "javascript");
	});
	it("returns markdown for .md", () => {
		assert.strictEqual(langForPath("readme.md"), "markdown");
	});
	it("returns extension for unknown type", () => {
		assert.strictEqual(langForPath("file.xyz"), "xyz");
	});
});

describe("formatToolCall", () => {
	it("formats write command with file and line count", () => {
		const result = formatToolCall("write", {
			file_path: "/home/user/test.ts",
			content: "line1\nline2\nline3",
		}, noopFg);
		assert.ok(result.includes("test.ts"));
		assert.ok(result.includes("3 lines"));
	});

	it("formats edit command", () => {
		const result = formatToolCall("edit", {
			file_path: "/home/user/test.ts",
			oldText: "foo",
			newText: "bar",
		}, noopFg);
		assert.ok(result.includes("test.ts"));
	});

	it("shortens home directory path", () => {
		const home = os.homedir();
		const result = formatToolCall("read", {
			file_path: `${home}/projects/file.ts`,
		}, noopFg);
		assert.ok(result.includes("~/projects/file.ts"));
	});
});
