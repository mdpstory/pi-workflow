// ---- wf_knowledge_put / wf_knowledge_get (P1-1) ----
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { role, workflowActive } from "../lib/identity.ts";
import { freshFragments, listCoverage } from "../lib/knowledge.ts";
import { knowledgeDir, repoRoot } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";

export function registerKnowledgeTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "wf_knowledge_put",
		label: "wf_knowledge_put",
		description: "Store an immutable analysis fragment about a source file so other agents (or future workflow runs) can reuse it instead of re-deriving. scope=general is durable/repo-wide; scope=task is disposable, this workflow only — task notes disappear with the workflow id, so promote durable facts to general.",
		parameters: Type.Object({
			file: Type.String({ description: "repo-relative path of the source file this note is about" }),
			note: Type.String(),
			scope: StringEnum(["general", "task"]),
		}),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const dir = knowledgeDir(params.file, params.scope as "general" | "task");
			fs.mkdirSync(dir, { recursive: true });
			let mtime = "";
			let size = "";
			let hash = "";
			try {
				const abs = path.resolve(repoRoot(), params.file);
				const st = fs.statSync(abs);
				mtime = String(st.mtimeMs);
				size = String(st.size);
				hash = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
			} catch {
				// source file doesn't exist (yet, or was deleted) — fragment is always stale on read
			}
			// (P1-4) hash is the authoritative freshness check — mtime/size are a cheap
			// pre-filter only (freshFragments hashes the source and compares before trusting
			// them). A same-size character swap, or a git checkout that preserves mtime,
			// must not be served as fresh.
			const frag = `---\nfile: ${params.file}\nrole: ${role()}\nmtime: ${mtime}\nsize: ${size}\nhash: ${hash}\nwritten: ${new Date().toISOString()}\n---\n${params.note.trim()}\n`;
			const name = `${process.pid}-${Date.now()}-${role()}.md`;
			const tmp = path.join(dir, `.tmp-${name}`);
			fs.writeFileSync(tmp, frag);
			fs.renameSync(tmp, path.join(dir, name)); // atomic — immutable fragments never collide
			return ok(`stored fragment ${name} (scope=${params.scope})`);
		},
	});

	pi.registerTool({
		name: "wf_knowledge_get",
		label: "wf_knowledge_get",
		description: "Retrieve stored analysis fragments about a source file — general (repo-wide) and task (this workflow) scope — filtered to ones still fresh (mtime+size match). Call before reading a source file another agent may already have analyzed. Omit `file` to list every file with fresh/stale coverage instead (P1-1).",
		parameters: Type.Object({ file: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			if (!params.file) {
				const rows = listCoverage();
				if (!rows.length) return { content: [{ type: "text", text: "no knowledge fragments stored yet" }], details: { ok: true } };
				const lines = ["path | scope | fragments | fresh?", "--- | --- | --- | ---", ...rows.map((r) => `${r.file} | ${r.scope} | ${r.fragments} | ${r.fresh ? "yes" : "stale"}`)];
				return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: true } };
			}
			const { sections, staleCount } = freshFragments(params.file);
			const staleNote = staleCount ? `\n\n_${staleCount} stale fragment(s) skipped — file changed since last analysis._` : "";
			const text = sections.length ? `${sections.join("\n\n")}${staleNote}` : `no fragments found for ${params.file}${staleNote}`;
			return { content: [{ type: "text", text }], details: { ok: true } };
		},
	});
}
