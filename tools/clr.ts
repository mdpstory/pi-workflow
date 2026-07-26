// ---- wf_clr_open / wf_clr_resolve / wf_retry_bump / wf_retry_rule ----
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STAGES, stageIndex, type Stage } from "../lib/constants.ts";
import { requireDirector, role, workflowActive } from "../lib/identity.ts";
import { writeJson } from "../lib/io.ts";
import { artifactsDir, clrIndexPath } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";
import { clrBlocksStage, loadClr, loadState, saveState } from "../lib/state.ts";

export function registerClrTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "wf_clr_open",
		label: "wf_clr_open",
		description: "File a clarification request. Halts caller. Any role.",
		parameters: Type.Object({
			stage: Type.Optional(StringEnum([...STAGES])),
			question: Type.String(),
		}),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const state = loadState();
			// (P1-1) `stage` used to be free-form caller input: an agent could file against a
			// *downstream* stage and keep writing, since clrBlocksStage only gates idx <= curIdx.
			// Default to the workflow's actual current stage, and reject an explicit stage
			// strictly later than current — filing ahead of where the workflow is cannot halt
			// anything, so it isn't a meaningful CLR, it's an opt-out.
			const stage = params.stage ?? state.current;
			if (!stage) return deny("no current stage and no explicit stage given — workflow has no in-progress stage to file against");
			if (state.current && stageIndex(stage) > stageIndex(state.current)) {
				return deny(`stage "${stage}" is downstream of current stage "${state.current}" — a CLR filed there would block nothing; omit \`stage\` to file against the current stage, or file once that stage is actually reached`);
			}
			const id = `CLR-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
			const clr = loadClr();
			clr.open.push({ id, stage, raisedBy: role() });
			writeJson(clrIndexPath(), clr);
			const entry = `\n## ${id}\n- Status: OPEN\n- Raised by: ${role()}\n- Stage: ${stage}\n- Question: ${params.question}\n- Resolution: _pending_\n- Resolved by: _pending_\n`;
			const clrFile = path.join(artifactsDir(), "clarifications.md");
			fs.appendFileSync(clrFile, entry);
			// mark stage blocked — but only if it isn't already "done". Filing a CLR against
			// a stage the workflow has already progressed past shouldn't retroactively flip
			// its recorded status backward and corrupt the audit trail; the open CLR still
			// blocks all further writes via clrBlocksStage regardless of this status field.
			const target = state.stages[stage as Stage];
			if (target && target.status !== "done") {
				target.status = "blocked";
				saveState(state);
			}
			return { content: [{ type: "text", text: `HALT: filed ${id}. Stop current work.` }], details: { ok: true, id } };
		},
	});

	pi.registerTool({
		name: "wf_clr_resolve",
		label: "wf_clr_resolve",
		description: "Resolve a CLR. Director only for now.",
		parameters: Type.Object({ id: Type.String(), resolution: Type.String() }),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const clr = loadClr();
			const before = clr.open.length;
			const target = clr.open.find((c) => c.id === params.id);
			clr.open = clr.open.filter((c) => c.id !== params.id);
			if (clr.open.length === before) return deny(`no OPEN CLR with id ${params.id}`);
			writeJson(clrIndexPath(), clr);
			// append resolution note
			fs.appendFileSync(
				path.join(artifactsDir(), "clarifications.md"),
				`\n<!-- ${params.id} resolved by director: ${params.resolution} -->\n`,
			);
			// (C6) Restore "blocked" → "in-progress" once nothing else still blocks that stage —
			// previously a resolved CLR left the stage's status permanently stuck at "blocked"
			// even though clrBlocksStage() (the thing that actually gates writes) had already
			// cleared. status was write-only: set by wf_clr_open, never consulted or restored.
			if (target) {
				const state = loadState();
				const stageRec = state.stages[target.stage as Stage];
				if (stageRec && stageRec.status === "blocked" && !clrBlocksStage(clr, target.stage as Stage).blocked) {
					stageRec.status = "in-progress";
					saveState(state);
				}
			}
			return ok(`resolved ${params.id}`);
		},
	});

	pi.registerTool({
		name: "wf_retry_bump",
		label: "wf_retry_bump",
		description: "Record a failed attempt for <key> (e.g. CLR id or defect slug). Returns OK, DIRECTOR_RULE at 3 bumps, or HUMAN if key already has 3 rulings. Same-bug key spans Review+QA loops.",
		parameters: Type.Object({ key: Type.String({ description: "stable defect / CLR key" }) }),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const state = loadState();
			const rec = state.rulings[params.key] ?? { bumps: 0, ruled: 0 };
			if (rec.ruled >= 3) {
				return { content: [{ type: "text", text: `HUMAN: ${params.key} has ${rec.ruled} director rulings — escalate.` }], details: { ok: false, decision: "HUMAN", key: params.key, ...rec } };
			}
			rec.bumps += 1;
			state.rulings[params.key] = rec;
			// NOTE: bumps live only on state.rulings[key] — keyed by defect key, not by
			// "whichever stage happens to be state.current right now". A defect bumped once
			// during review and again during testing (same key, per docs: "same-bug key spans
			// Review+QA loops") must accumulate correctly across that stage boundary; mirroring
			// onto state.current would silently split the count across two unrelated stage
			// counters instead. wf_stage_complete's retry-cap check (step 3, "retry limit")
			// reads state.rulings directly instead of a per-stage mirror.
			saveState(state);
			if (rec.bumps >= 3) {
				return { content: [{ type: "text", text: `DIRECTOR_RULE: ${params.key} at ${rec.bumps} bumps — director must rule via wf_retry_rule.` }], details: { ok: true, decision: "DIRECTOR_RULE", key: params.key, ...rec } };
			}
			return { content: [{ type: "text", text: `OK: ${params.key} bumps=${rec.bumps}` }], details: { ok: true, decision: "OK", key: params.key, ...rec } };
		},
	});

	pi.registerTool({
		name: "wf_retry_rule",
		label: "wf_retry_rule",
		description: "Director ruling on a stuck retry key. Resets bumps, increments ruled count, logs to decisions.md. HUMAN escalation at 3 rulings.",
		parameters: Type.Object({ key: Type.String(), ruling: Type.String({ description: "the decision text" }) }),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const state = loadState();
			const rec = state.rulings[params.key] ?? { bumps: 0, ruled: 0 };
			rec.ruled += 1;
			rec.bumps = 0;
			state.rulings[params.key] = rec;
			saveState(state);
			fs.appendFileSync(
				path.join(artifactsDir(), "decisions.md"),
				`\n## ruling on ${params.key} (#${rec.ruled}/3)\n${params.ruling}\n`,
			);
			const esc = rec.ruled >= 3 ? " — next bump escalates to HUMAN" : "";
			return { content: [{ type: "text", text: `ruled ${params.key} (${rec.ruled}/3)${esc}` }], details: { ok: true, key: params.key, ...rec } };
		},
	});
}
