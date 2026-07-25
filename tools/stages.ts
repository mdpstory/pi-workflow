// ---- wf_stage_start / wf_stage_complete / wf_approve ----
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentGitSha, isArchitectureFresh, stampArchitecture } from "../lib/architecture.ts";
import { resetToolCalls, TOOL_CAP } from "../lib/ceiling.ts";
import { requireApprovalSet, requirePreApprovalSet, skipStagesSet } from "../lib/config.ts";
import { ARTIFACT_FOR_STAGE, nextStage, ROLE_FOR_STAGE, STAGES, stageIndex, type Stage } from "../lib/constants.ts";
import { requireDirector, requireHumanGate, workflowId } from "../lib/identity.ts";
import { acquireOrCheckLock } from "../lib/lock.ts";
import { artifactPath, artifactsDir } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";
import { clrBlocksStage, isStubContent, loadClr, loadState, saveState } from "../lib/state.ts";

export function registerStageTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "wf_stage_start",
		label: "wf_stage_start",
		description: "Set current stage to <stage>. Director only. Rejects if previous stage not done. Stages listed in skipStages config are auto-skipped and chained through.",
		parameters: Type.Object({ stage: StringEnum([...STAGES]) }),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const state = loadState();
			const target = params.stage as Stage;
			const idx = stageIndex(target);
			// Block if pre-approval pending for previous stage
			if (state.pendingPreApproval) {
				return deny(`PRE_APPROVAL_REQUIRED: stage "${state.pendingPreApproval.completedStage}" done — user must approve before starting "${target}". User: call wf_continue(stage="${target}", verdict="approve"|"reject", note?)`);
			}
			if (idx > 0) {
				const prevOk = state.stages[STAGES[idx - 1]].status === "done";
				if (!prevOk) {
					return deny(`previous stage "${STAGES[idx - 1]}" not done`);
				}
			}
			// --- auto-skip chain: fast-forward through any configured skip stages ---
			fs.mkdirSync(artifactsDir(), { recursive: true }); // guard: ensure dir exists even if wf_init wasn't called first
			const skip = skipStagesSet();
			const clrForSkip = loadClr();
			const skippedChain: Stage[] = [];
			const freshChain: Stage[] = [];
			let cur: Stage | null = target;
			while (cur) {
				// An OPEN CLR at or before this stage must stop the auto-skip chain here —
				// otherwise a stage with an unresolved clarification gets silently marked
				// "done" via config, leaving state internally inconsistent. Surface it as the
				// normal in-progress/blocked stage instead so the director resolves it normally.
				if (clrBlocksStage(clrForSkip, cur).blocked) break;
				if (skip.has(cur)) {
					state.stages[cur].status = "done";
					state.stages[cur].sha = "auto-skip";
					skippedChain.push(cur);
					cur = nextStage(cur);
					continue;
				}
				// architecture is never blanket-skipped, but IS skipped when the repo tree
				// hasn't changed since architecture.md was last stamped (git-diff check,
				// no full re-scan needed).
				if (cur === "architecture") {
					const { fresh, sha: headSha } = isArchitectureFresh();
					if (fresh && headSha) {
						state.stages[cur].status = "done";
						state.stages[cur].sha = headSha;
						freshChain.push(cur);
						cur = nextStage(cur);
						continue;
					}
				}
				break;
			}
			if (cur) {
				state.current = cur;
				state.stages[cur].status = "in-progress";
			} else {
				state.current = null;
			}
			saveState(state);
			if (skippedChain.length) {
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## auto-skip (skipStages config)\n- Skipped: ${skippedChain.join(", ")}\n`,
				);
			}
			if (freshChain.length) {
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## auto-skip (architecture.md unchanged since last stamp)\n- Skipped: ${freshChain.join(", ")}\n`,
				);
			}
			acquireOrCheckLock(); // refresh lock; also self-reclaims a stale one

			// Reset per-stage tool budget so each stage gets a fresh 50-call cap
			resetToolCalls();

			const allSkipped = [...skippedChain, ...freshChain];

			// (C1) Auto-skipped stages are ALREADY marked done above — do not instruct the
			// director to call wf_stage_complete(sha:"auto-skip") for them, that sha fails the
			// `^[0-9a-f]{7,40}$` validation and produced an infinite BLOCKED loop. Say so
			// explicitly. (wf_stage_complete also now no-ops safely if called anyway — see C1
			// note there.)
			if (!cur) {
				return ok(`stage(s) skipped: ${allSkipped.join(", ")}. Workflow reached end — no stage in-progress. Do NOT call wf_stage_complete for skipped stages, they are already "done".`);
			}

			// Delegation guidance (P0-1): env passthrough, not a task-text prefix convention.
			const delegateRole = ROLE_FOR_STAGE[cur];
			const artifacts = ARTIFACT_FOR_STAGE[cur];
			const artifactList = artifacts.length ? artifacts.join(", ") : "source code";
			const skippedNote = allSkipped.length
				? ` (auto-skipped: ${allSkipped.join(", ")} — do NOT call wf_stage_complete for those, they are already "done")`
				: "";
			const hint = [
				`\n\nDELEGATE: subagent({ agent: "${delegateRole}", env: { PI_WORKFLOW_ROLE: "${delegateRole}", PI_WORKFLOW_ID: "${workflowId()}" }, task: "Load skill wf-${delegateRole}. ..." })`,
				`Each subagent gets a fresh context window and ${TOOL_CAP}-tool budget.`,
				`Expected artifacts: ${artifactList}`,
				`When finished, call wf_stage_complete("${cur}", sha).`,
			].join(" ");
			return ok(`stage started: ${cur}${skippedNote}${hint}`);
		},
	});

	pi.registerTool({
		name: "wf_stage_complete",
		label: "wf_stage_complete",
		description: "Run transition checklist for <stage>. Director only. Requires a change marker (git SHA from `git rev-parse HEAD` if the project is a git repo; if not, omit `sha` and one is auto-generated). Blocks if OPEN CLR names this or upstream stage, or required artifact absent.",
		parameters: Type.Object({
			stage: StringEnum([...STAGES]),
			sha: Type.Optional(Type.String({ description: "git SHA from `git rev-parse HEAD`. Optional — if the project has no git repo, omit this and a placeholder marker is generated automatically." })),
			skip: Type.Optional(Type.String({ description: "trivial-task escape: skip this and remaining pre-implementation stages, reason logged to decisions.md" })),
		}),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			const state = loadState();
			const clr = loadClr();
			const stage = params.stage as Stage;

			// (C1) Already-done stage (auto-skip, or a stray repeat call) → APPROVED no-op
			// instead of running the full checklist (which would reject a non-sha "auto-skip"
			// marker and BLOCK forever).
			if (state.stages[stage].status === "done" && !params.skip) {
				return {
					content: [{ type: "text", text: `APPROVED (noop) — ${stage} already done @ ${state.stages[stage].sha ?? "?"}` }],
					details: { ok: true, decision: "APPROVED", stage, sha: state.stages[stage].sha, noop: true },
				};
			}

			const sha = params.sha ?? crypto.randomBytes(4).toString("hex");

			// --- trivial-task escape hatch ---
			if (params.skip) {
				const implIdx = stageIndex("implementation");
				const startIdx = stageIndex(stage);
				if (startIdx === -1 || startIdx >= implIdx) {
					return deny("skip only allowed on pre-implementation stages");
				}
				if (!/^[0-9a-f]{7,40}$/i.test(sha)) return deny(`bad sha: ${sha}`);
				const skipped: string[] = [];
				for (let i = startIdx; i < implIdx; i++) {
					const s = STAGES[i];
					state.stages[s].status = "done";
					state.stages[s].sha = sha;
					skipped.push(s);
				}
				state.current = "implementation";
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## trivial-task skip @ ${sha.slice(0, 7)}\n- Skipped: ${skipped.join(", ")}\n- Reason: ${params.skip}\n`,
				);
				return {
					content: [{ type: "text", text: `SKIPPED ${skipped.join(", ")} → implementation` }],
					details: { ok: true, decision: "SKIPPED", skipped, sha },
				};
			}

			const errors: string[] = [];

			// 1. artifact exists — waived for stages configured via skipStages config
			const autoSkip = skipStagesSet().has(stage);
			for (const art of autoSkip ? [] : ARTIFACT_FOR_STAGE[stage]) {
				const abs = artifactPath(art);
				if (!fs.existsSync(abs) || isStubContent(fs.readFileSync(abs, "utf8"))) {
					errors.push(`artifact missing or stub: ${art}`);
				}
			}

			// 2. CLR gate
			const gate = clrBlocksStage(clr, stage);
			if (gate.blocked) errors.push(`OPEN CLRs block: ${gate.ids.join(", ")}`);

			// 3. (C2) retry limit — >= 3, matching wf_retry_bump's own DIRECTOR_RULE threshold.
			// Previously this used `> 3`, one bump later than the bump tool itself warned at.
			const stuckKeys = Object.entries(state.rulings).filter(([, rec]) => rec.bumps >= 3).map(([key]) => key);
			if (stuckKeys.length) errors.push(`retry cap exceeded for key(s) needing wf_retry_rule: ${stuckKeys.join(", ")}`);

			// 4. SHA sanity
			if (!/^[0-9a-f]{7,40}$/i.test(sha)) errors.push(`bad sha: ${sha}`);

			if (errors.length) {
				return {
					content: [{ type: "text", text: `BLOCKED\n- ${errors.join("\n- ")}` }],
					details: { ok: false, decision: "BLOCKED", errors },
				};
			}

			// --- P3: human-in-the-loop gate ---
			// A stage listed in requireApproval does NOT get marked done here. Instead this
			// halts with AWAITING_HUMAN and a summary; only wf_approve (callable exclusively by
			// an "unassigned" — i.e. human — session) can finalize it.
			if (requireApprovalSet().has(stage)) {
				const summary = [
					"## produced",
					`- artifact(s): ${ARTIFACT_FOR_STAGE[stage].join(", ") || "source code"}`,
					"## next",
					`- director intends to proceed to: ${nextStage(stage) ?? "(workflow end)"}`,
					"## question",
					`- is this correct? good to proceed? call wf_approve(stage="${stage}", sha="${sha}", verdict="approve"|"reject", note?)`,
				].join("\n");
				state.pendingApproval = { stage, sha, summary };
				saveState(state);
				return {
					content: [{ type: "text", text: `AWAITING_HUMAN\n${summary}` }],
					details: { ok: false, decision: "AWAITING_HUMAN", stage, sha },
				};
			}

			if (stage === "architecture") {
				const head = currentGitSha();
				if (head) stampArchitecture(head); // record what tree state this architecture.md reflects
			}
			state.stages[stage].status = "done";
			state.stages[stage].sha = sha;

			// --- P4: pre-approval gate ---
			// After marking stage done, check if NEXT stage needs user approval before starting.
			const nxt = nextStage(stage);
			if (nxt && requirePreApprovalSet().has(nxt)) {
				const artifactList = ARTIFACT_FOR_STAGE[stage].join(", ") || "source code";
				const summary = [
					`## completed: ${stage}`,
					`- artifact(s): ${artifactList}`,
					`- sha: ${sha.slice(0, 7)}`,
					`## next stage: ${nxt}`,
					`- role: ${ROLE_FOR_STAGE[nxt]}`,
					`- expected artifacts: ${ARTIFACT_FOR_STAGE[nxt].join(", ") || "source code"}`,
					`## question`,
					`- approve starting ${nxt}? call wf_continue(stage="${nxt}", verdict="approve"|"reject", note?)`,
				].join("\n");
				state.pendingPreApproval = { nextStage: nxt, completedStage: stage, sha, summary };
				state.current = null; // no stage in-progress while awaiting pre-approval
				saveState(state);
				return {
					content: [{ type: "text", text: `PRE_APPROVAL_REQUIRED\n${summary}` }],
					details: { ok: false, decision: "PRE_APPROVAL_REQUIRED", stage, nextStage: nxt, sha },
				};
			}

			state.current = nxt;
			saveState(state);
			return {
				content: [{ type: "text", text: `APPROVED ${stage} @ ${sha.slice(0, 7)}` }],
				details: { ok: true, decision: "APPROVED", stage, sha },
			};
		},
	});

	pi.registerTool({
		name: "wf_approve",
		label: "wf_approve",
		description: "Approve or reject a stage awaiting the human gate (see requireApproval config). Callable only by the human: an unassigned session, or the director session relaying an explicit human verdict. Never by a dispatched agent role.",
		parameters: Type.Object({
			stage: StringEnum([...STAGES]),
			sha: Type.String(),
			verdict: StringEnum(["approve", "reject"]),
			note: Type.Optional(Type.String({ description: "required context for reject — becomes the correction brief" })),
		}),
		async execute(_id, params) {
			const blocked = requireHumanGate("wf_approve");
			if (blocked) return deny(blocked.msg);
			const state = loadState();
			if (!state.pendingApproval || state.pendingApproval.stage !== params.stage || state.pendingApproval.sha !== params.sha) {
				return deny(`no matching pending approval for stage=${params.stage} sha=${params.sha}`);
			}
			if (params.verdict === "reject") {
				state.pendingApproval = null;
				state.stages[params.stage as Stage].status = "in-progress";
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## human rejection: ${params.stage} @ ${params.sha.slice(0, 7)}\n${params.note ?? "(no note given)"}\n`,
				);
				return ok(`REJECTED ${params.stage} — reset to in-progress with correction note in decisions.md`);
			}
			if (params.stage === "architecture") {
				const head = currentGitSha();
				if (head) stampArchitecture(head);
			}
			state.stages[params.stage as Stage].status = "done";
			state.stages[params.stage as Stage].sha = params.sha;

			// Check pre-approval for next stage
			const nxt = nextStage(params.stage as Stage);
			if (nxt && requirePreApprovalSet().has(nxt)) {
				const artifactList = ARTIFACT_FOR_STAGE[params.stage as Stage].join(", ") || "source code";
				const summary = [
					`## completed: ${params.stage}`,
					`- artifact(s): ${artifactList}`,
					`- sha: ${params.sha.slice(0, 7)}`,
					`## next stage: ${nxt}`,
					`- role: ${ROLE_FOR_STAGE[nxt]}`,
					`- expected artifacts: ${ARTIFACT_FOR_STAGE[nxt].join(", ") || "source code"}`,
					`## question`,
					`- approve starting ${nxt}? call wf_continue(stage="${nxt}", verdict="approve"|"reject", note?)`,
				].join("\n");
				state.pendingPreApproval = { nextStage: nxt, completedStage: params.stage as Stage, sha: params.sha, summary };
				state.current = null;
				saveState(state);
				return {
					content: [{ type: "text", text: `PRE_APPROVAL_REQUIRED\n${summary}` }],
					details: { ok: false, decision: "PRE_APPROVAL_REQUIRED", stage: params.stage, nextStage: nxt, sha: params.sha },
				};
			}

			state.current = nxt;
			state.pendingApproval = null;
			saveState(state);
			return ok(`APPROVED (human) ${params.stage} @ ${params.sha.slice(0, 7)}`);
		},
	});

	// --- wf_continue: user approves/rejects pre-approval for next stage ---
	pi.registerTool({
		name: "wf_continue",
		label: "wf_continue",
		description: "Approve or reject starting the next stage after pre-approval gate. Callable only by the human: an unassigned session, or the director session relaying an explicit human verdict.",
		parameters: Type.Object({
			stage: StringEnum([...STAGES]),
			verdict: StringEnum(["approve", "reject"]),
			note: Type.Optional(Type.String({ description: "required context for reject — becomes the correction brief" })),
		}),
		async execute(_id, params) {
			const blocked = requireHumanGate("wf_continue");
			if (blocked) return deny(blocked.msg);
			const state = loadState();
			if (!state.pendingPreApproval || state.pendingPreApproval.nextStage !== params.stage) {
				return deny(`no matching pre-approval for nextStage=${params.stage}`);
			}
			if (params.verdict === "reject") {
				// Reset completed stage back to in-progress so director can re-run with corrections
				const completedStage = state.pendingPreApproval.completedStage;
				const completedSha = state.pendingPreApproval.sha;
				state.stages[completedStage as Stage].status = "in-progress";
				state.current = completedStage;
				state.pendingPreApproval = null;
				saveState(state);
				fs.appendFileSync(
					path.join(artifactsDir(), "decisions.md"),
					`\n## pre-approval rejection: ${params.stage} @ ${completedSha?.slice(0, 7) ?? "?"}\n${params.note ?? "(no note given)"}\n`,
				);
				return ok(`REJECTED ${params.stage} — reset ${completedStage} to in-progress with correction note in decisions.md`);
			}
			// Approve: clear pre-approval, allow director to proceed
			state.pendingPreApproval = null;
			saveState(state);
			return ok(`PRE-APPROVED ${params.stage} — director may now call wf_stage_start("${params.stage}")`);
		},
	});
}
