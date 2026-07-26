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
