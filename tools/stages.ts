// ---- wf_stage_start / wf_stage_complete / wf_approve ----
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentGitSha, isArchitectureFresh, stampArchitecture } from "../lib/architecture.ts";
import { currentToolCap, resetToolCalls } from "../lib/ceiling.ts";
import { requireApprovalSet, requireDiscussionBeforeImpl, requirePreApprovalSet, skipStagesSet } from "../lib/config.ts";
import { discussionCount, hasDiscussionTopic } from "../lib/discussion.ts";
import { ARTIFACT_FOR_STAGE, nextStage, ROLE_FOR_STAGE, STAGES, stageIndex, type Stage } from "../lib/constants.ts";
import { nextGateStage, resolveApproval, resolvePreApproval } from "../lib/gates.ts";
import { requireDirector, requireHumanGate, role } from "../lib/identity.ts";
import { acquireOrCheckLock } from "../lib/lock.ts";
import { artifactPath, artifactsDir } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";
import { clrBlocksStage, isStubContent, loadClr, loadState, saveState } from "../lib/state.ts";

// The stage the user is actually being asked to approve: the next one that will really run.
// Stages configured in skipStages (or already marked done) are fast-forwarded past, otherwise
// wf_stage_start auto-skips them and the pending gate is left pointing at a dead stage.
function allSkippedSoFar(a: Stage[], b: Stage[]): string {
	return [...a, ...b].join(", ") || "(none)";
}

// (P0-3) Human gate is code-enforced, not convention-only. requireHumanGate lets both
// "unassigned" (the human, directly) and "director" (relaying a human verdict) call
// wf_approve/wf_continue — but nothing used to distinguish relaying from inventing. When
// the caller is director AND a UI is available, force an explicit confirm() showing the
// exact verdict being relayed.
//
// (Fix C / F2) Headless hole closed: with no UI the director used to simply return true and
// stamp `relayed-by-director` — i.e. in `pi -p` mode it could approve its own gates with no
// human keystroke at all. Now a headless relay REQUIRES `note` carrying the user's own words
// (>= 8 chars), which is quoted verbatim into decisions.md as the audit trail. No note, no
// approval.
const MIN_RELAY_NOTE = 8;

async function confirmHumanVerdict(
	ctx: unknown,
	tool: string,
	stage: string,
	sha: string | undefined,
	verdict: string,
	note: string | undefined,
	summary?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (role() !== "director") return { ok: true }; // unassigned session IS the human — nothing to relay
	const anyCtx = ctx as { hasUI?: boolean; ui?: { confirm: (t: string, m: string) => Promise<boolean> } };
	const stageLabel = stage.replace(/-/g, " ");
	const shaPart = sha ? ` @ ${sha.slice(0, 7)}` : "";
	const verb = verdict === "approve" ? "Approve" : "Reject";
	if (anyCtx?.hasUI && anyCtx.ui?.confirm) {
		const cleaned = summary?.replace(/\n## question[\s\S]*$/, "") ?? "";
		const detail = cleaned ? `\n\n${cleaned}` : "";
		const confirmed = await anyCtx.ui.confirm(
			"pi-workflow",
			`The Director wants to ${verb.toLowerCase()} \"${stageLabel}\".${detail}\n\nIs this what you decided?`,
		);
		return confirmed ? { ok: true } : { ok: false, reason: "human declined to confirm this verdict via the UI prompt" };
	}
	const trimmed = (note ?? "").trim();
	if (trimmed.length < MIN_RELAY_NOTE) {
		return {
			ok: false,
			reason: `headless director-relay requires note=<the user's exact chat words> (>= ${MIN_RELAY_NOTE} chars). No UI is available to capture a human keystroke, so the note IS the audit trail — you may not ${verdict} "${stage}" on the user's behalf without it.`,
		};
	}
	fs.mkdirSync(artifactsDir(), { recursive: true });
	fs.appendFileSync(
		path.join(artifactsDir(), "decisions.md"),
		`\n## relayed-by-director: ${tool} verdict=${verdict} stage=${stage}${shaPart} (no UI — human words quoted below)\n> ${trimmed.replace(/\n/g, "\n> ")}\n`,
	);
	return { ok: true };
}

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
			// Block if pre-approval pending for previous stage.
			// A gate whose stage is already done (auto-skipped, or completed by another path) is
			// stale — drop it silently instead of deadlocking the director on a stage nobody can run.
			if (state.pendingPreApproval) {
				const gated = state.pendingPreApproval.nextStage as Stage;
				if (state.stages[gated]?.status === "done") {
					state.pendingPreApproval = null;
					saveState(state);
				} else {
					// Quote the GATED stage, not the requested one — wf_continue matches on nextStage.
					// Carry decision/nextStage/stage/sha in details so the tool_result hook (hooks.ts)
					// can also intercept this and pop the confirm dialog immediately, same as the
					// gateOnLanding path further down — otherwise a UI session would have to wait for
					// the LLM to relay this as text and call wf_continue itself.
					return {
						content: [{ type: "text", text: `PRE_APPROVAL_REQUIRED: stage "${state.pendingPreApproval.completedStage}" done — user must approve before starting "${gated}". User: call wf_continue(stage="${gated}", verdict="approve"|"reject", note?)` }],
						details: { ok: false, decision: "PRE_APPROVAL_REQUIRED", stage: state.pendingPreApproval.completedStage, nextStage: gated, sha: state.pendingPreApproval.sha },
					};
				}
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
			// The skip chain can land on a DIFFERENT stage than the one the user pre-approved
			// (architecture freshness is decided here, not at wf_stage_complete time). If that
			// landing stage itself requires pre-approval, gate it now — otherwise auto-skip would
			// silently start a stage the user never approved.
			const gateOnLanding = !!cur && cur !== target && requirePreApprovalSet().has(cur);

			// (Fix B / F1) Soft-enforced discussion gate: no code lands before the director has
			// actually talked to the user. Two entries minimum — kickoff, plus a plan/arch/scope
			// confirmation. Checked before saveState (so a blocked start leaves disk untouched) and
			// after the pre-approval landing check (a stage that isn't going to start anyway is the
			// pre-approval gate's business, not this one's).
			if (cur === "implementation" && !gateOnLanding && requireDiscussionBeforeImpl()) {
				const n = discussionCount();
				if (n < 2) {
					return deny(
						`Director must discuss with the user before starting implementation (${n}/2 discussion entries recorded). Talk to the user, then log each exchange with wf_discuss({ topic, proposal, userSaid, decision }) — e.g. "kickoff" (confirm what they asked for) and "impl-scope" (confirm the task graph + scope). Set requireDiscussionBeforeImpl:false in .pi/pi-workflow.json to disable this gate.`,
					);
				}
			}
			if (cur && !gateOnLanding) {
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
			if (cur && gateOnLanding) {
				const from = STAGES[stageIndex(cur) - 1];
				const summary = [
					`## auto-skipped: ${allSkippedSoFar(skippedChain, freshChain)}`,
					`## next stage: ${cur}`,
					`- role: ${ROLE_FOR_STAGE[cur]}`,
					`- expected artifacts: ${ARTIFACT_FOR_STAGE[cur].join(", ") || "source code"}`,
					`## question`,
					`- approve starting ${cur}? call wf_continue(stage="${cur}", verdict="approve"|"reject", note?)`,
				].join("\n");
				state.pendingPreApproval = { nextStage: cur, completedStage: from, sha: state.stages[from]?.sha ?? "auto-skip", summary };
				saveState(state);
				return {
					content: [{ type: "text", text: `PRE_APPROVAL_REQUIRED\n${summary}` }],
					details: { ok: false, decision: "PRE_APPROVAL_REQUIRED", stage: from, nextStage: cur },
				};
			}
			acquireOrCheckLock(); // refresh lock; also self-reclaims a stale one

			// Reset per-stage tool budget so each stage gets a fresh cap (larger for implementation)
			resetToolCalls(cur);

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
				`\n\nDELEGATE: subagent({ agent: "${delegateRole}", task: "Load skill wf-${delegateRole}. ..." }) — do NOT pass env: role/id come from the dispatched agent's workflowRole frontmatter, not caller-supplied env.`,
				`Each subagent gets a fresh context window and tool budget (this stage's cap: ${currentToolCap()}).`,
				`Register each dispatch with wf_dispatch_note BEFORE calling subagent(...) and clear it with done:true after, so a resumed director never double-dispatches.`,
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
				// (Fix B / F4) The trivial-task escape used to be a unilateral director call that
				// bypassed planning/research/architecture with zero user involvement. The user must
				// have agreed the task is trivial, on the record.
				if (requireDiscussionBeforeImpl() && !hasDiscussionTopic("trivial-scope")) {
					return deny(
						'trivial-task skip requires the user\'s agreement on the record: wf_discuss({ topic: "trivial-scope", proposal: "treating as trivial: <reason>", userSaid: "<their exact words>" }) first.',
					);
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
			const nxt = nextGateStage(state, stage);
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
			note: Type.Optional(Type.String({ description: "the user's exact words. Required for reject (becomes the correction brief) AND for any headless (no-UI) director relay (becomes the audit trail)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const blocked = requireHumanGate("wf_approve");
			if (blocked) return deny(blocked.msg);
			const preState = loadState();
			const summary = preState.pendingApproval?.summary;
			const confirmed = await confirmHumanVerdict(ctx, "wf_approve", params.stage, params.sha, params.verdict, params.note, summary);
			if (!confirmed.ok) return deny(confirmed.reason);
			// Re-load: confirm() was awaited, state may have moved under us.
			const state = loadState();
			if (!state.pendingApproval || state.pendingApproval.stage !== params.stage || state.pendingApproval.sha !== params.sha) {
				return deny(`no matching pending approval for stage=${params.stage} sha=${params.sha}`);
			}
			// StringEnum widens to `string` at the type level; the schema constrains the runtime value.
const result = resolveApproval(state, params.stage as Stage, params.sha, params.verdict as "approve" | "reject", params.note, "tool");
			saveState(state);
			if (result.kind === "pre-approval-required") {
				return {
					content: [{ type: "text", text: result.text }],
					details: { ok: false, decision: "PRE_APPROVAL_REQUIRED", stage: params.stage, nextStage: result.nextStage, sha: params.sha },
				};
			}
			return ok(result.text);
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
			note: Type.Optional(Type.String({ description: "the user's exact words. Required for reject (becomes the correction brief) AND for any headless (no-UI) director relay (becomes the audit trail)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const blocked = requireHumanGate("wf_continue");
			if (blocked) return deny(blocked.msg);
			const preState = loadState();
			const summary = preState.pendingPreApproval?.summary;
			const confirmed = await confirmHumanVerdict(ctx, "wf_continue", params.stage, undefined, params.verdict, params.note, summary);
			if (!confirmed.ok) return deny(confirmed.reason);
			// Re-load: confirm() was awaited, state may have moved under us.
			const state = loadState();
			if (!state.pendingPreApproval || state.pendingPreApproval.nextStage !== params.stage) {
				return deny(`no matching pre-approval for nextStage=${params.stage}`);
			}
			const completedStage = state.pendingPreApproval.completedStage;
			const completedSha = state.pendingPreApproval.sha;
			const result = resolvePreApproval(state, params.stage as Stage, completedStage as Stage, completedSha, params.verdict as "approve" | "reject", params.note, "tool");
			saveState(state);
			return ok(result.text);
		},
	});
}
