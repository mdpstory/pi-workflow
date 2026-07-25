// ---- wf_status / wf_write_artifact / wf_artifact_summary ----
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentGitSha, stampArchitecture } from "../lib/architecture.ts";
import { ARTIFACT_MDS, SHARED_ARTIFACTS } from "../lib/constants.ts";
import { role, workflowId } from "../lib/identity.ts";
import { isPathAllowedForRole } from "../lib/access.ts";
import { isPidAlive, readLock } from "../lib/lock.ts";
import { artifactPath } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";
import { clrBlocksStage, loadClr, loadState } from "../lib/state.ts";

export function registerStatusTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "wf_status",
		label: "wf_status",
		description: "Dump workflow state, current stage, open CLRs. Any role, including unassigned.",
		parameters: Type.Object({}),
		async execute() {
			const state = loadState();
			const clr = loadClr();
			const lock = readLock();
			const lockLine = lock
				? `lock: pid ${lock.pid} on ${lock.host} (${isPidAlive(lock.pid) ? "ALIVE" : "STALE — will be reclaimed"}), started ${lock.startedAt}`
				: "lock: none";
			const lines = [
				`role: ${role()}`,
				`workflow id: ${workflowId()}`,
				`current: ${state.current ?? "—"}`,
				`open CLRs: ${clr.open.length ? clr.open.map((c) => `${c.id}(${c.stage})`).join(", ") : "none"}`,
				`pending approval: ${state.pendingApproval ? `${state.pendingApproval.stage} @ ${state.pendingApproval.sha}` : "none"}`,
				lockLine,
				"",
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { state, clr, lock } };
		},
	});

	// (C9: reconcile the divergence — this tool was registered by some installed copy but
	// absent from this canonical index.ts)
	pi.registerTool({
		name: "wf_write_artifact",
		label: "wf_write_artifact",
		description: "Safely writes a workflow artifact to .workflow/<id>/artifacts/. Cannot touch source files.",
		parameters: Type.Object({
			filename: Type.String({ description: "artifact filename, e.g. plan.md, research.md" }),
			content: Type.String(),
		}),
		async execute(_id, params) {
			if (!ARTIFACT_MDS.has(params.filename)) {
				return deny(`"${params.filename}" is not a recognized workflow artifact (${[...ARTIFACT_MDS].join(", ")})`);
			}
			const r = role();
			const rel = SHARED_ARTIFACTS.has(params.filename)
				? `.workflow/shared/artifacts/${params.filename}`
				: `.workflow/${workflowId()}/artifacts/${params.filename}`;
			const allow = isPathAllowedForRole(r, rel);
			if (!allow.ok) return deny(allow.reason ?? "not permitted");

			const state = loadState();
			const clr = loadClr();
			const gate = clrBlocksStage(clr, state.current);
			const isClarifications = params.filename === "clarifications.md";
			if (gate.blocked && !isClarifications) {
				return deny(`OPEN CLR(s) block writes: ${gate.ids.join(", ")}. Resolve via wf_clr_resolve before editing.`);
			}

			const abs = artifactPath(params.filename);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, params.content);
			if (params.filename === "architecture.md") {
				const head = currentGitSha();
				if (head) stampArchitecture(head);
			}
			return ok(`wrote ${params.content.length} chars to ${params.filename}`);
		},
	});

	// (P4: director token diet) Director previously read every artifact in full for every
	// poll. This returns only heading/verdict lines (`## ...`, `verdict:`, `DRAFT —
	// incomplete` markers) — cheap enough to call after every subagent report. Read the
	// full artifact only on BLOCKED or immediately before presenting an AWAITING_HUMAN summary.
	pi.registerTool({
		name: "wf_artifact_summary",
		label: "wf_artifact_summary",
		description: "Return only heading/verdict lines from an artifact (## headings, `verdict:` lines, DRAFT markers) instead of the full text — cheap director polling. Read the full artifact only on BLOCKED or before a human-gate summary.",
		parameters: Type.Object({ artifact: Type.String({ description: "artifact filename, e.g. review.md" }) }),
		async execute(_id, params) {
			const abs = artifactPath(params.artifact);
			let text: string;
			try {
				text = fs.readFileSync(abs, "utf8");
			} catch {
				return deny(`no such artifact: ${params.artifact}`);
			}
			const lines = text.split("\n").filter((l) => /^#{1,3}\s/.test(l) || /verdict\s*:/i.test(l) || /DRAFT — incomplete/i.test(l));
			return {
				content: [{ type: "text", text: lines.length ? lines.join("\n") : "(no heading/verdict lines found — read in full)" }],
				details: { ok: true },
			};
		},
	});
}
