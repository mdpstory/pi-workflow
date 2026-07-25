// ---- per-session tool-call ceiling ----
export const TOOL_CAP = 50;
let toolCalls = 0;

/** Reset tool counter — called on session start and when a new stage starts so each
 *  stage gets its own budget instead of sharing one across the entire session. */
export function resetToolCalls(): void {
	toolCalls = 0;
}
export function bumpToolCalls(): number {
	return ++toolCalls;
}
export function currentToolCalls(): number {
	return toolCalls;
}
