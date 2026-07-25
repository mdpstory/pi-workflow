// ---- session/workflow id + role identity (P0-2, P0-3) ----
//
// Role model: three states, not two.
//   - "unassigned": no PI_WORKFLOW_ROLE env, no in-process wf_claim() call. A casual,
//     non-workflow session. No write gating. Only wf_status/wf_claim/wf_approve usable
//     among wf_* tools.
//   - "director": PI_WORKFLOW_ROLE=director env, OR wf_claim("director") called
//     in-process (never persisted to disk, never inherited by children — loading skill
//     wf-director calls wf_claim as step 0). Director's own write allowlist (ROLE_ALLOW.director)
//     is hard-enforced, same as every other role.
//   - "<role>": PI_WORKFLOW_ROLE=<role> env — a dispatched subagent. Role allowlist +
//     CLR gate enforced.
// workflowActive() = role() !== "unassigned". Gating (write/edit hook, tool ceiling) only
// activates once a role exists — including for the director itself.
//
// Workflow id: PI_WORKFLOW_ID env > .workflow/.active-id marker (read+written by
// every role, not director-only — makes "kill and restart" resume the same workflow) >
// mint fresh + write marker. wf_new() mints an explicit new id (start workflow #2, not by
// restarting a session). wf_list() enumerates all `.workflow/<id>/` namespaces.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { wfRoot } from "./base-paths.ts";

export function mintId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// Resolution order (P0-3):
//   1. PI_WORKFLOW_ID env var — explicit, and the mechanism subagents rely on (director
//      passes it via `subagent({ env: { PI_WORKFLOW_ID } })`).
//   2. .workflow/.active-id marker — read (and written if absent) by ANY role, director
//      included. This is what makes "kill the director, restart" resume the same
//      workflow instead of minting a fresh id every process start.
//   3. Neither present → mint fresh, write marker.
// wf_new() explicitly mints a NEW id and overwrites the marker — that's how you start a
// second, independent workflow, rather than by restarting the session.
let _sessionId: string | undefined;
export function markerPath(): string {
	return path.join(wfRoot(), ".active-id");
}
export function sessionId(): string {
	if (_sessionId) return _sessionId;
	try {
		const existing = fs.readFileSync(markerPath(), "utf8").trim();
		if (existing) return (_sessionId = existing);
	} catch {
		// no marker yet — mint below
	}
	const fresh = mintId();
	try {
		fs.mkdirSync(wfRoot(), { recursive: true });
		fs.writeFileSync(markerPath(), fresh);
	} catch {
		// best-effort; if we can't persist it, other sessions just won't converge
	}
	return (_sessionId = fresh);
}
/** Explicitly set the in-memory session id (used by wf_new after minting+writing the marker). */
export function setSessionId(id: string): void {
	_sessionId = id;
}
export function currentSessionId(): string | undefined {
	return _sessionId;
}
export function workflowId(): string {
	if (process.env.PI_WORKFLOW_ID) {
		const safe = process.env.PI_WORKFLOW_ID.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
		if (safe) return safe;
	}
	return sessionId();
}

// In-process only — never written to disk, never inherited by a spawned child (children get
// their identity from PI_WORKFLOW_ROLE env, set explicitly by the director's subagent dispatch).
let _claimedRole: string | undefined;

export function claimRole(r: string): void {
	_claimedRole = r;
}
export function role(): string {
	const v = process.env.PI_WORKFLOW_ROLE;
	if (v) return v.toLowerCase();
	if (_claimedRole) return _claimedRole;
	return "unassigned";
}
// Gating (role allowlist, CLR gate, tool ceiling) activates the moment a role exists —
// including for the director, once claimed. A bare pi session with nothing loaded stays
// "unassigned": untouched, no gating, only wf_status/wf_claim/wf_approve usable.
export function workflowActive(): boolean {
	return role() !== "unassigned";
}
export function requireDirector(): { ok: false; msg: string } | null {
	const r = role();
	if (r === "unassigned") return { ok: false, msg: "no role claimed — load skill wf-director or set PI_WORKFLOW_ROLE" };
	if (r !== "director") return { ok: false, msg: "director only" };
	return null;
}
