// ---- small JSON/JSONL file helpers ----
import * as fs from "node:fs";
import * as path from "node:path";

export function readJson<T>(p: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8")) as T;
	} catch {
		return fallback;
	}
}
export function writeJson(p: string, obj: unknown): void {
	// Atomic write: write to a temp file then rename, so a kill mid-write
	// can never leave a half-written / corrupt state.json or clr-index.json.
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
	fs.renameSync(tmp, p);
}
export function readJsonl(p: string): Array<Record<string, string>> {
	try {
		return fs
			.readFileSync(p, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
