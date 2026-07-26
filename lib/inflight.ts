// ---- in-flight subagent dispatch tracking (Fix F / F5) ----
// A resumed director otherwise has no idea whether the previous session already dispatched
// an engineer for T2 — it can double-dispatch. The director calls wf_dispatch_note right
// before subagent(...) and again with done:true after it returns; wf_status surfaces
// anything still open, plus how long it has been open (a stale entry from a killed session
// is visible as "started 40m ago" rather than silently lost).
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "./io.ts";
import { inflightDir } from "./paths.ts";

export interface InflightRec {
	agent: string;
	task: string;
	stage?: string;
	startedAt: string;
	pid: number;
	key: string;
}

function keyFor(agent: string, task: string): string {
	const slug = `${agent}-${task}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
	return slug.replace(/^-+|-+$/g, "") || "dispatch";
}

export function noteDispatch(agent: string, task: string, stage?: string): InflightRec {
	const dir = inflightDir();
	fs.mkdirSync(dir, { recursive: true });
	const rec: InflightRec = { agent, task, stage, startedAt: new Date().toISOString(), pid: process.pid, key: keyFor(agent, task) };
	fs.writeFileSync(path.join(dir, `${rec.key}.json`), JSON.stringify(rec, null, 2));
	return rec;
}

export function clearDispatch(agent: string, task: string): boolean {
	const abs = path.join(inflightDir(), `${keyFor(agent, task)}.json`);
	try {
		fs.unlinkSync(abs);
		return true;
	} catch {
		return false;
	}
}

export function listInflight(): InflightRec[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(inflightDir()).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	return files
		.map((f) => readJson<InflightRec | null>(path.join(inflightDir(), f), null))
		.filter((r): r is InflightRec => !!r && !!r.agent)
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function renderInflight(recs: InflightRec[]): string {
	if (!recs.length) return "none";
	const now = Date.now();
	return recs
		.map((r) => {
			const mins = Math.max(0, Math.round((now - Date.parse(r.startedAt)) / 60000));
			return `${r.agent}${r.stage ? `/${r.stage}` : ""} (pid ${r.pid}, ${mins}m ago): ${r.task.slice(0, 80)}`;
		})
		.join("\n");
}
