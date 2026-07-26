// ---- knowledge fragment helpers (P1-1, P1-2) ----
// Shared by wf_knowledge_get and the P1-2 read-interception hook.
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot, wfRoot } from "./base-paths.ts";
import { workflowId } from "./identity.ts";
import { knowledgeDir } from "./paths.ts";

// P1-2: keep at most the newest K fragments per scope when returning fresh sections —
// N agents analyzing the same file must not multiply retrieval tokens by N forever.
const MAX_FRESH_PER_SCOPE = 3;

// Collect fresh (mtime+size still matching the on-disk source) fragments for a file.
// `only` restricts the scan to one scope — used by listCoverage so a task row's fresh flag
// reflects task fragments, not a fresh general fragment for the same file.
export function freshFragments(file: string, only?: "general" | "task"): { sections: string[]; staleCount: number } {
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
	for (const [scope, label] of scopes.filter(([s]) => !only || s === only)) {
		const dir = knowledgeDir(file, scope);
		let files: string[] = [];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".tmp-")).sort();
		} catch {
			// no fragments for this file/scope yet
		}
		type Fresh = { written: string; text: string; body: string };
		const all: Fresh[] = [];
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
				const body = fm[2].trim();
				all.push({ written: meta.written ?? "?", text: `### ${meta.role ?? "?"} @ ${meta.written ?? "?"}\n${body}`, body });
			} else {
				staleCount += 1;
			}
		}
		// P1-2: newest-by-`written` first, drop byte-identical dupes (same insight re-stored
		// by another role/session adds nothing), then cap to MAX_FRESH_PER_SCOPE.
		all.sort((a, b) => (a.written < b.written ? 1 : a.written > b.written ? -1 : 0));
		const fresh: Fresh[] = [];
		for (const f of all) {
			if (fresh.some((k) => k.body === f.body)) continue;
			fresh.push(f);
		}
		const kept = fresh.slice(0, MAX_FRESH_PER_SCOPE);
		const omitted = fresh.length - kept.length;
		const body = kept.map((k) => k.text).join("\n\n") + (omitted > 0 ? `\n\n_${omitted} older fragment(s) omitted_` : "");
		if (kept.length) sections.push(`## ${label}\n${body}`);
	}
	return { sections, staleCount };
}

// P1-1: coverage listing — what has already been analyzed, across both scopes.
// Reverses sanitizeFilePath by reading the `file:` frontmatter of the first fragment in
// each dir rather than trying to un-mangle the sanitized directory name.
export interface CoverageRow {
	file: string;
	scope: "general" | "task";
	fragments: number;
	fresh: boolean;
}
function scanKnowledgeRoot(root: string, scope: "general" | "task"): CoverageRow[] {
	const rows: CoverageRow[] = [];
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return rows;
	}
	for (const d of dirs) {
		const dir = path.join(root, d);
		let files: string[] = [];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".tmp-")).sort();
		} catch {
			continue;
		}
		if (!files.length) continue;
		let file = d;
		try {
			const raw = fs.readFileSync(path.join(dir, files[0]), "utf8");
			const m = /^---\n(?:[\s\S]*?\n)?file:\s*(.+)\n[\s\S]*?\n---\n/.exec(raw);
			if (m) file = m[1].trim();
		} catch {
			// fall back to sanitized dir name
		}
		const { sections } = freshFragments(file, scope);
		rows.push({ file, scope, fragments: files.length, fresh: sections.length > 0 });
	}
	return rows;
}
export function listCoverage(): CoverageRow[] {
	const rows = [
		...scanKnowledgeRoot(path.join(wfRoot(), "shared", "knowledge"), "general"),
		...scanKnowledgeRoot(path.join(wfRoot(), workflowId(), "knowledge"), "task"),
	];
	return rows.sort((a, b) => a.file.localeCompare(b.file) || a.scope.localeCompare(b.scope));
}
