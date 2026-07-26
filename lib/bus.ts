// ---- shared bus append ----
// The message bus is plain per-role JSONL under .workflow/<id>/bus/, appended via a
// single appendFileSync call (atomic under concurrent writers). Extracted here so
// non-tool code paths (the approval gates in gates.ts) can post too, instead of the
// write living only inside the wf_msg_post tool handler.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { busDir, busFile } from "./paths.ts";

export interface BusMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	threadId: string;
	ts: string;
}

export function postMessage(from: string, to: string, body: string, threadId = ""): BusMessage {
	fs.mkdirSync(busDir(), { recursive: true });
	const target = to.toLowerCase() === "all" ? "all" : to.toLowerCase();
	const msg: BusMessage = {
		id: crypto.randomBytes(4).toString("hex"),
		from,
		to: target,
		body,
		threadId,
		ts: new Date().toISOString(),
	};
	fs.appendFileSync(busFile(target), `${JSON.stringify(msg)}\n`); // single write() syscall — atomic under concurrent writers
	return msg;
}
