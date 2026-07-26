// ---- wf_status / wf_write_artifact / wf_artifact_summary ----
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentGitSha, stampArchitecture } from "../lib/architecture.ts";
import { ARTIFACT_MDS, SHARED_ARTIFACTS } from "../lib/constants.ts";
import { requireDirector, role, workflowId } from "../lib/identity.ts";
import { isPathAllowedForRole } from "../lib/access.ts";
import { lockLiveness, readLock } from "../lib/lock.ts";
import { artifactPath, intentPath } from "../lib/paths.ts";
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
			let intent: string | null = null;
			try {
				const t = fs.readFileSync(intentPath(), "utf8").trim();
				if (t) intent = t;
			} catch {
				// no intent recorded yet
			}
			const lockLine = lock
				? `lock: pid ${lock.pid} on ${lock.host} (${
						lockLiveness(lock) === "alive"
							? "ALIVE"
							: lockLiveness(lock) === "unknown-foreign-host"
								? "UNKNOWN — foreign host, will not be silently reclaimed"
								: "STALE — will be reclaimed"
					}), started ${lock.startedAt}`
				: "lock: none";
			const lines = [
				`role: ${role()}`,
				`workflow id: ${workflowId()}`,
				`current: ${state.current ?? "—"}`,
				`open CLRs: ${clr.open.length ? clr.open.map((c) => `${c.id}(${c.stage})`).join(", ") : "none"}`,
				`pending approval: ${state.pendingApproval ? `${state.pendingApproval.stage} @ ${state.pendingApproval.sha}` : "none"}`,
				`pending pre-approval: ${state.pendingPreApproval ? `${state.pendingPreApproval.nextStage} (after ${state.pendingPreApproval.completedStage} @ ${state.pendingPreApproval.sha})` : "none"}`,
				lockLine,
				"",
				"--- director memory (first-person log — your POV + where you left off) ---",
				intent ?? "(none recorded — call wf_intent to log the user's request + your routing decisions so they survive an abort)",
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { state, clr, lock, intent } };
		},
	});

	// Director's durable first-person memory/log. Persisted to .workflow/<id>/intent.md so a
	// NEW director session that resumes a workflow (via the .active-id marker) recovers both the
	// original request AND the prior director's routing POV / where it left off — even if aborted
	// before any stage artifact (plan.md) was written. Append-by-default; each entry auto-stamped.
	pi.registerTool({
		name: "wf_intent",
		label: "wf_intent",
		description:
			"Director's persistent first-person memory/log. Append a POV entry after every decision so a resumed session knows where it stood and what it intended next — e.g. \"user want /health api\", \"scout ran, spawning planner with scout's knowledge\", \"tasks read, dispatching 3 parallel engineers on T1/T2/T3\". Call with {brief} (append is the default) to log an entry; {brief, replace:true} to reset the whole log; no args to read it back. Survives session kill / early abort. Director only.",
		parameters: Type.Object({
			brief: Type.Optional(Type.String({ description: "a first-person POV entry: what you just learned/decided and what you intend to do next; omit to just read current memory" })),
			replace: Type.Optional(Type.Boolean({ description: "reset the entire log instead of appending (rarely needed)" })),
		}),
		async execute(_id, params) {
			const abs = intentPath();
			if (params.brief === undefined) {
				try {
					const t = fs.readFileSync(abs, "utf8");
					return { content: [{ type: "text", text: t || "(intent memory empty)" }], details: { ok: true, intent: t } };
				} catch {
					return { content: [{ type: "text", text: "(no intent memory recorded yet)" }], details: { ok: true, intent: null } };
				}
			}
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			const stamp = new Date().toISOString();
			if (params.replace) {
				fs.writeFileSync(abs, `# director memory (first-person log)\n\n- [${stamp}] ${params.brief}\n`);
				return ok(`reset director memory (${params.brief.length} chars) — survives session kill`);
			}
			if (!fs.existsSync(abs)) fs.writeFileSync(abs, "# director memory (first-person log)\n\n");
			fs.appendFileSync(abs, `- [${stamp}] ${params.brief}\n`);
			return ok(`logged director memory entry (${params.brief.length} chars) — survives session kill`);
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
