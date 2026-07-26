// ---- wf_msg_post / wf_msg_poll / wf_bus_digest (P2: agent bus) ----
// Replaces `intercom` for subagent<->subagent and subagent<->director coordination:
// intercom targets interactive sessions by discoverable name, which dispatched
// subagents don't have, and its messages die with the process. The bus is plain
// per-role JSONL under .workflow/<id>/bus/, appended via a single appendFileSync call
// (same atomicity argument as wf_context_append had) — survives process death, fully
// auditable after the run.
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { postMessage } from "../lib/bus.ts";
import { requireDirector, role, workflowActive } from "../lib/identity.ts";
import { readJsonl } from "../lib/io.ts";
import { busDir, busFile } from "../lib/paths.ts";
import { deny, ok } from "../lib/reply.ts";

export function registerBusTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "wf_msg_post",
		label: "wf_msg_post",
		description: 'Post a message to another role\'s bus, or "all". Survives process death; readable after both sender and recipient exit.',
		parameters: Type.Object({
			to: Type.String({ description: 'role name (e.g. "engineer") or "all"' }),
			body: Type.String(),
			threadId: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const msg = postMessage(role(), params.to, params.body, params.threadId ?? "");
			return ok(`posted to ${msg.to}: ${msg.id}`);
		},
	});

	pi.registerTool({
		name: "wf_msg_poll",
		label: "wf_msg_poll",
		description: 'Poll messages addressed to caller\'s role or "all", optionally only since an ISO timestamp.',
		parameters: Type.Object({ since: Type.Optional(Type.String({ description: "ISO timestamp — only messages strictly after this" })) }),
		async execute(_id, params) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const r = role();
			let msgs = [...readJsonl(busFile(r)), ...readJsonl(busFile("all"))];
			msgs.sort((a, b) => (a.ts as string).localeCompare(b.ts as string));
			if (params.since) msgs = msgs.filter((m) => (m.ts as string) > params.since!);
			const text = msgs.length ? msgs.map((m) => `[${m.ts}] ${m.from}→${m.to}: ${m.body}`).join("\n") : "no messages";
			return { content: [{ type: "text", text }], details: { messages: msgs } };
		},
	});

	// (Fix J / F6) Peer coordination, honestly scoped. The bus is fire-and-forget: engineer A
	// can finish before engineer B ever posts, and nothing can make a one-shot spawned process
	// stay alive waiting. wf_msg_wait only blocks THIS process for up to timeoutMs — use it for
	// "I know a peer owes me an interface decision", not as a general sync primitive.
	pi.registerTool({
		name: "wf_msg_wait",
		label: "wf_msg_wait",
		description:
			"Block up to timeoutMs waiting for a bus message addressed to your role (optionally from a specific role). Returns as soon as one arrives, or reports a timeout. NOT a cross-process sync guarantee — a peer that already exited will never post; on timeout, proceed or file a CLR.",
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "only count messages from this role" })),
			timeoutMs: Type.Optional(Type.Number({ description: "max wait in ms (default 30000, hard max 300000)" })),
			since: Type.Optional(Type.String({ description: "ISO timestamp — only messages strictly after this (default: now)" })),
		}),
		async execute(_id, params, signal) {
			if (!workflowActive()) return deny("no role claimed — load a role skill or set PI_WORKFLOW_ROLE");
			const r = role();
			const since = params.since ?? new Date().toISOString();
			const timeout = Math.min(Math.max(params.timeoutMs ?? 30_000, 0), 300_000);
			const deadline = Date.now() + timeout;
			const poll = () =>
				[...readJsonl(busFile(r)), ...readJsonl(busFile("all"))]
					.filter((m) => (m.ts as string) > since && (!params.from || m.from === params.from))
					.sort((a, b) => (a.ts as string).localeCompare(b.ts as string));
			for (;;) {
				const hits = poll();
				if (hits.length) {
					return {
						content: [{ type: "text", text: hits.map((m) => `[${m.ts}] ${m.from}→${m.to}: ${m.body}`).join("\n") }],
						details: { ok: true, messages: hits, timedOut: false },
					};
				}
				if (signal?.aborted || Date.now() >= deadline) break;
				await new Promise((res) => setTimeout(res, 500));
			}
			return {
				content: [
					{
						type: "text",
						text: `no message${params.from ? ` from ${params.from}` : ""} within ${timeout}ms. The peer may have already exited — bus messages are fire-and-forget, not live sync. Proceed on your own best judgement or file wf_clr_open.`,
					},
				],
				details: { ok: true, messages: [], timedOut: true },
			};
		},
	});

	pi.registerTool({
		name: "wf_bus_digest",
		label: "wf_bus_digest",
		description: "Full bus transcript across every role, oldest first. Director only.",
		parameters: Type.Object({}),
		async execute() {
			const denied = requireDirector();
			if (denied) return deny(denied.msg);
			let files: string[] = [];
			try {
				files = fs.readdirSync(busDir()).filter((f) => f.endsWith(".jsonl"));
			} catch {
				// no bus activity yet
			}
			const msgs = files.flatMap((f) => readJsonl(path.join(busDir(), f)));
			msgs.sort((a, b) => (a.ts as string).localeCompare(b.ts as string));
			const text = msgs.length ? msgs.map((m) => `[${m.ts}] ${m.from}→${m.to}: ${m.body}`).join("\n") : "no messages";
			return { content: [{ type: "text", text }], details: { messages: msgs } };
		},
	});
}
