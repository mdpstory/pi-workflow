// ---- knowledge fragment helpers (P1-1) ----
// Shared by wf_knowledge_get and the P1-2 read-interception hook.
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot } from "./base-paths.ts";
import { knowledgeDir } from "./paths.ts";

// Collect fresh (mtime+size still matching the on-disk source) fragments for a file.
export function freshFragments(file: string): { sections: string[]; staleCount: number } {
	let curMtime = "";
	let curSize = "";
	try {
		const st = fs.statSync(path.resolve(repoRoot(), file));
		curMtime = String(st.mtimeMs);
		curSize = String(st.size);
	} catch {
		// missing source — everything reads as stale, which is correct
	}
	const sections: string[] = [];
	let staleCount = 0;
	const scopes: Array<["general" | "task", string]> = [
		["general", "General (repo-wide)"],
		["task", "Task-specific (this workflow)"],
	];
	for (const [scope, label] of scopes) {
		const dir = knowledgeDir(file, scope);
		let files: string[] = [];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".tmp-")).sort();
		} catch {
			// no fragments for this file/scope yet
		}
		const fresh: string[] = [];
		for (const f of files) {
			const raw = fs.readFileSync(path.join(dir, f), "utf8");
			const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
			if (!fm) continue;
			const meta: Record<string, string> = {};
			for (const line of fm[1].split("\n")) {
				const idx = line.indexOf(":");
				if (idx === -1) continue;
				meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
			if (curMtime && meta.mtime === curMtime && meta.size === curSize) {
				fresh.push(`### ${meta.role ?? "?"} @ ${meta.written ?? "?"}\n${fm[2].trim()}`);
			} else {
				staleCount += 1;
			}
		}
		if (fresh.length) sections.push(`## ${label}\n${fresh.join("\n\n")}`);
	}
	return { sections, staleCount };
}
