// ---- wf_claim / wf_new / wf_list / wf_init ----
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wfRoot } from "../lib/base-paths.ts";
import { ARTIFACT_MDS } from "../lib/constants.ts";
import { claimRole, currentSessionId, markerPath, mintId, requireDirector, setSessionId, workflowId } from "../lib/identity.ts";
import { lockLiveness, type LockInfo, readLock, acquireOrCheckLock } from "../lib/lock.ts";
import { readJson, writeJson } from "../lib/io.ts";
import { artifactPath, artifactsDir, clrIndexPath, repoRoot, sharedArtifactsDir } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";
import { isStubContent, loadClr, loadState, saveState, type WfState } from "../lib/state.ts";

export function registerLifecycleTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "wf_claim",
		label: "wf_claim",
		description:
			"Claim a role for THIS process only (in-memory, never written to disk, never inherited by subagents). Loading skill wf-director calls wf_claim(\"director\") as step 0 — that is what makes a session the director, not merely being unassigned.",
		parameters: Type.Object({ role: StringEnum(["director"]) }),
		async execute(_id, params) {
			if (process.env.PI_WORKFLOW_ROLE) {
				return deny(`role already fixed via env PI_WORKFLOW_ROLE=${process.env.PI_WORKFLOW_ROLE} — wf_claim not needed/applicable`);
			}
			claimRole(params.role);
			return ok(`claimed role: ${params.role} (in-process only)`);
		},
	});

	pi.registerTool({
		name: "wf_new",
		label: "wf_new",
		description: "Mint a fresh workflow id, update the resume marker, and return it. Use this to start a second/parallel workflow instead of relying on session restart. Director only.",
		parameters: Type.Object({ label: Type.Optional(Type.String({ description: "short human label appended to the id" })) }),
		async execute(_id, params) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			if (process.env.PI_WORKFLOW_ID) {
				return deny(`PI_WORKFLOW_ID=${process.env.PI_WORKFLOW_ID} is set explicitly — wf_new cannot override an env-pinned id; unset it or start a new process/env for a second workflow`);
			}
			const label = params.label ? params.label.trim().replace(/[^a-zA-Z0-9._-]/g, "-") : "";
			const fresh = label ? `${mintId()}-${label}` : mintId();
			setSessionId(fresh);
			try {
				fs.mkdirSync(wfRoot(), { recursive: true });
				fs.writeFileSync(markerPath(), fresh);
			} catch {
				// best-effort
			}
			return ok(`new workflow id: ${fresh} (marker updated — call wf_init next)`);
		},
	});

	pi.registerTool({
		name: "wf_list",
		label: "wf_list",
		description: "Enumerate .workflow/<id>/ namespaces in this repo with current stage and director-lock liveness. Any role.",
		parameters: Type.Object({}),
		async execute() {
			const root = wfRoot();
			let ids: string[] = [];
			try {
				ids = fs
					.readdirSync(root, { withFileTypes: true })
					.filter((d) => d.isDirectory() && d.name !== "shared")
					.map((d) => d.name);
			} catch {
				// no .workflow/ yet
			}
			if (!ids.length) return { content: [{ type: "text", text: "no workflows found" }], details: { ids: [] } };
			const lines = ids.map((id) => {
				const st = readJson<WfState | null>(path.join(root, id, "state.json"), null);
				const lock = readJson<LockInfo | null>(path.join(root, id, "director.lock"), null);
				const liveness = lock ? lockLiveness(lock) : null;
				const lockStr = lock
					? liveness === "alive"
						? `ALIVE pid ${lock.pid}`
						: liveness === "unknown-foreign-host"
							? `UNKNOWN pid ${lock.pid} on foreign host ${lock.host}`
							: "STALE"
					: "none";
				const marker = id === (currentSessionId() ?? "") ? " (this session)" : "";
				return `${id}${marker}: current=${st?.current ?? "—"} lock=${lockStr}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: { ids } };
		},
	});

	pi.registerTool({
		name: "wf_init",
		label: "wf_init",
		description: "Initialize .workflow/ state and stub artifacts. Director only.",
		parameters: Type.Object({
			forceReclaimForeignLock: Type.Optional(Type.Boolean({ description: "explicit override to reclaim a lock reported UNKNOWN (foreign host) — only pass this after confirming with the user that no other machine is actually running this workflow" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			fs.mkdirSync(artifactsDir(), { recursive: true });

			// (C5) Ask before writing .gitignore (when there's a UI to ask through), and match
			// both ".workflow" and ".workflow/" forms — the old check only looked for the
			// slashed form and would append a duplicate entry for a bare ".workflow" line.
			const gitignorePath = path.join(repoRoot(), ".gitignore");
			const hasEntryRe = /(^|\n)\s*\.workflow\/?\s*($|\n)/;
			if (fs.existsSync(gitignorePath)) {
				const gitignore = fs.readFileSync(gitignorePath, "utf8");
				if (!hasEntryRe.test(gitignore)) {
					let proceed = true;
					const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: { confirm: (t: string, m: string) => Promise<boolean> } };
					if (anyCtx?.hasUI && anyCtx.ui?.confirm) {
						proceed = await anyCtx.ui.confirm("pi-workflow", 'Append ".workflow/" to .gitignore?');
					}
					if (proceed) fs.appendFileSync(gitignorePath, "\n.workflow/\n");
				}
			} else {
				fs.writeFileSync(gitignorePath, ".workflow/\n");
			}
			const foreign = acquireOrCheckLock(params.forceReclaimForeignLock === true);
			if (foreign) {
				// (P1-7) Distinguish "definitely another live director, same host" from "lock's
				// host doesn't match this one" — the latter is ambiguous (could be a real live
				// process on another machine sharing this checkout, or a stale lock nobody ever
				// cleaned up) and must not be silently reclaimed OR silently treated as blocking
				// forever. Requires an explicit forceReclaimForeignLock:true to override.
				const liveness = lockLiveness(foreign);
				const foreignHostMsg = liveness === "unknown-foreign-host"
					? `UNKNOWN (foreign host "${foreign.host}" ≠ this host "${os.hostname()}") — could be a live process on another machine sharing this checkout, or a stale lock. If you've confirmed no other machine is running this workflow, retry with forceReclaimForeignLock: true.`
					: `pid ${foreign.pid} on ${foreign.host} is ALIVE`;
				return {
					content: [{
						type: "text",
						text: `BLOCKED: another director session may already be running workflow "${workflowId()}" (${foreignHostMsg}, started ${foreign.startedAt}). ` +
							`If that session is dead (same-host case), it will self-clear next time this is called. To work on a second feature in parallel in this same repo, call wf_new (or set a distinct PI_WORKFLOW_ID, e.g. PI_WORKFLOW_ID=notifications) before calling wf_init — each id gets its own isolated .workflow/<id>/ lock, state, and artifacts. Alternatively use a separate git worktree.`,
					}],
					details: { ok: false, decision: "LOCKED", lock: foreign, liveness },
				};
			}
			const state = loadState();
			saveState(state);
			writeJson(clrIndexPath(), loadClr());
			fs.mkdirSync(sharedArtifactsDir(), { recursive: true });
			for (const md of ARTIFACT_MDS) {
				const abs = artifactPath(md);
				const stub = `# ${md.replace(".md", "")}\n\n_empty_\n`;
				const content = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
				if (content === null || isStubContent(content)) fs.writeFileSync(abs, stub);
			}
			return { content: [{ type: "text", text: "workflow initialized" }], details: { ok: true } };
		},
	});
}
