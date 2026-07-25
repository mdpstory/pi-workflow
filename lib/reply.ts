// ---- tool reply shorthands ----
export function ok(msg: string) {
	return { content: [{ type: "text", text: msg }], details: { ok: true } };
}
export function deny(msg: string) {
	return { content: [{ type: "text", text: `denied: ${msg}` }], details: { ok: false, reason: msg } };
}
