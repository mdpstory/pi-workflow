// ---- per-session tool-call ceiling ----
// (Fix I / F8) The ceiling resets per stage, but `implementation` is ONE stage in which the
// director dispatches AND polls many parallel engineers — it hit the hard stop mid-graph and
// needed a process restart. The cap is therefore stage-dependent: implementation gets a
// larger budget, every other stage keeps the original 50.
export const TOOL_CAP = 50;
export const STAGE_TOOL_CAP: Record<string, number> = { implementation: 120 };

let toolCalls = 0;
let cap = TOOL_CAP;

/** Reset tool counter — called on session start and when a new stage starts so each
 *  stage gets its own budget instead of sharing one across the entire session.
 *  Passing the stage also sizes the budget for that stage (see STAGE_TOOL_CAP). */
export function resetToolCalls(stage?: string): void {
	toolCalls = 0;
	cap = (stage && STAGE_TOOL_CAP[stage]) || TOOL_CAP;
}
export function bumpToolCalls(): number {
	return ++toolCalls;
}
export function currentToolCalls(): number {
	return toolCalls;
}
/** Cap in force for the stage currently running. */
export function currentToolCap(): number {
	return cap;
}
