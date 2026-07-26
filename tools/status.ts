// ---- wf_status / wf_write_artifact / wf_artifact_summary ----
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentGitSha, stampArchitecture } from "../lib/architecture.ts";
import { ARTIFACT_MDS, SHARED_ARTIFACTS } from "../lib/constants.ts";
import { appendDiscussion, readDiscussion, renderDiscussion, resetDiscussion } from "../lib/discussion.ts";
import { requireDirector, role, workflowId } from "../lib/identity.ts";
import { clearDispatch, listInflight, noteDispatch, renderInflight } from "../lib/inflight.ts";
import { isPathAllowedForRole } from "../lib/access.ts";
import { readJson, readJsonl, writeJson } from "../lib/io.ts";
import { lockLiveness, readLock } from "../lib/lock.ts";
import { computeNextAction } from "../lib/nextaction.ts";
import { artifactPath, busFile, intentPath, lastStatusPath } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";
import { clrBlocksStage, loadClr, loadState } from "../lib/state.ts";

// Unread bus traffic addressed to the director since the previous wf_status call (Fix E /
// F11). A rejection brief posted by the human gate lands on the bus; nothing used to make
// the director notice it. The cursor lives in .workflow/<id>/last-status.json so it
// survives session death like everything else.
function unreadBus(): { count: number; rejections: number; lines: string[] } {
	const cursor = readJson<{ ts?: string }>(lastStatusPath(), {}).ts ?? "";
	const msgs = [...readJsonl(busFile("director")), ...readJsonl(busFile("all"))]
		.filter((m) => typeof m.ts === "string" && m.ts > cursor)
		.sort((a, b) => (a.ts as string).localeCompare(b.ts as string));
	return {
		count: msgs.length,
		rejections: msgs.filter((m) => m.from === "human-gate" || /^REJECTED/.test(m.body ?? "")).length,
		lines: msgs.slice(-5).map((m) => `[${m.ts}] ${m.from}→${m.to}: ${(m.body ?? "").split("\n").join(" | ")}`),
	};
}

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
			const discussion = readDiscussion();
			const inflight = listInflight();
			const bus = unreadBus();
			const nextAction = computeNextAction(state, clr);
			const lines = [
				`role: ${role()}`,
				`workflow id: ${workflowId()}`,
				`current: ${state.current ?? "—"}`,
				`open CLRs: ${clr.open.length ? clr.open.map((c) => `${c.id}(${c.stage})`).join(", ") : "none"}`,
				`pending approval: ${state.pendingApproval ? `${state.pendingApproval.stage} @ ${state.pendingApproval.sha}` : "none"}`,
				`pending pre-approval: ${state.pendingPreApproval ? `${state.pendingPreApproval.nextStage} (after ${state.pendingPreApproval.completedStage} @ ${state.pendingPreApproval.sha})` : "none"}`,
				lockLine,
				`in-flight subagents: ${inflight.length ? "" : "none"}`,
				...(inflight.length ? [renderInflight(inflight)] : []),
				`unread bus messages: ${bus.count}${bus.rejections ? ` (${bus.rejections} REJECTION BRIEF — read it before retrying)` : ""}`,
				...bus.lines,
				"",
				`NEXT ACTION: ${nextAction}`,
				"",
				"--- last discussion with the user (durable — survives session kill) ---",
				renderDiscussion(discussion.slice(-3)),
				"",
				"--- director memory (first-person log — your POV + where you left off) ---",
				intent ?? "(none recorded — call wf_intent to log the user's request + your routing decisions so they survive an abort)",
			];
			// Advance the unread cursor only for the director (the role that acts on it).
			if (role() === "director") {
				try {
					writeJson(lastStatusPath(), { ts: new Date().toISOString() });
				} catch {
					// best-effort cursor; never fail a status read over it
				}
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { state, clr, lock, intent, discussion, inflight, unreadBus: bus.count, nextAction },
			};
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

	// --- wf_discuss (Fix A) ---
	// The non-negotiable invariant: the Director is the one who talks to the user, and it
	// must actually have the conversation. Chat words die with the process; this makes the
	// exchange durable at .workflow/<id>/discussion.md, replayed by wf_status on resume and
	// verified by wf_stage_start("implementation") (Fix B).
	pi.registerTool({
		name: "wf_discuss",
		label: "wf_discuss",
		description:
			"Log a Director↔User discussion checkpoint to the durable discussion log. Director only (write); anyone may read by calling with no args. Mandatory checkpoints: kickoff, plan-review, arch-choice, impl-scope, review-verdict, final-signoff (plus trivial-scope before any wf_stage_complete skip). Record the user's reply VERBATIM in userSaid — it is the audit trail and the resume context.",
		parameters: Type.Object({
			topic: Type.Optional(Type.String({ description: 'short slug: kickoff | plan-review | arch-choice | impl-scope | review-verdict | final-signoff | trivial-scope | custom' })),
			proposal: Type.Optional(Type.String({ description: "what you asked/presented to the user, verbatim" })),
			userSaid: Type.Optional(Type.String({ description: "the user's reply, verbatim. Omit only when logging a fresh open question you have not yet had answered." })),
			decision: Type.Optional(Type.String({ description: 'resolved outcome: "proceed" | "revise: X" | "abort" | "custom: ..."' })),
			replace: Type.Optional(Type.Boolean({ description: "reset the whole discussion log instead of appending (rarely needed)" })),
		}),
		async execute(_id, params) {
			if (params.topic === undefined && params.proposal === undefined) {
				const entries = readDiscussion();
				return {
					content: [{ type: "text", text: renderDiscussion(entries) }],
					details: { ok: true, entries },
				};
			}
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			if (!params.topic) return deny("topic required (e.g. kickoff, plan-review, impl-scope)");
			if (!params.proposal) return deny("proposal required — what did you actually put to the user?");
			const entry = { topic: params.topic.trim(), proposal: params.proposal, userSaid: params.userSaid, decision: params.decision };
			const written = params.replace ? resetDiscussion(entry) : appendDiscussion(entry);
			const total = readDiscussion().length;
			return ok(
				`logged discussion "${written.topic}" (${total} entr${total === 1 ? "y" : "ies"} total) — survives session kill${params.userSaid ? "" : ". NOTE: no userSaid recorded — this counts as an OPEN question, log the user's reply when it arrives."}`,
			);
		},
	});

	// --- wf_dispatch_note (Fix F) ---
	// pi exposes no subagent lifecycle hook the extension can latch onto, so dispatch
	// tracking is cooperative: the director registers a dispatch immediately before calling
	// subagent(...) and clears it after. wf_status surfaces whatever is still open so a
	// resumed director does not double-dispatch the same task.
	pi.registerTool({
		name: "wf_dispatch_note",
		label: "wf_dispatch_note",
		description:
			"Register (or clear, with done:true) an in-flight subagent dispatch. Call immediately BEFORE subagent(...) and again with done:true after it returns. Survives session death so a resumed director sees what was already dispatched instead of double-dispatching. Director only.",
		parameters: Type.Object({
			agent: Type.String({ description: 'role being dispatched, e.g. "engineer"' }),
			task: Type.String({ description: "the task text you are about to hand the subagent (or the same text again when clearing)" }),
			stage: Type.Optional(Type.String({ description: "workflow stage this dispatch belongs to" })),
			done: Type.Optional(Type.Boolean({ description: "clear the record instead of creating it" })),
		}),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			if (params.done) {
				const cleared = clearDispatch(params.agent, params.task);
				return ok(cleared ? `cleared in-flight record for ${params.agent}` : `no in-flight record matched ${params.agent} (already cleared)`);
			}
			const rec = noteDispatch(params.agent, params.task, params.stage);
			return ok(`registered in-flight dispatch ${rec.key} (${rec.agent}) — clear it with done:true when the subagent returns`);
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
