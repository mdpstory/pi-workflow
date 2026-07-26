// ---- durable Director<->User discussion transcript (Fix A / F1 / F5) ----
//
// The Director must always discuss with the user — never fire-and-forget. That discussion
// used to live only in the killed session's chat log, so a resumed director recovered
// intent.md bullets but not what the user actually said. Every checkpoint is appended here
// as a timestamped block at .workflow/<id>/discussion.md, so:
//   - a resumed session replays the real exchange (zero context loss),
//   - wf_stage_start("implementation") can *verify* a discussion happened (Fix B),
//   - the trivial-task skip can no longer be taken unilaterally (F4).
import * as fs from "node:fs";
import * as path from "node:path";
import { discussionPath } from "./paths.ts";

export interface DiscussionEntry {
	ts: string;
	topic: string;
	proposal: string;
	userSaid?: string;
	decision?: string;
}

const HEADER = "# director <-> user discussion log\n\n";

export function appendDiscussion(entry: Omit<DiscussionEntry, "ts">): DiscussionEntry {
	const abs = discussionPath();
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	if (!fs.existsSync(abs)) fs.writeFileSync(abs, HEADER);
	const ts = new Date().toISOString();
	const lines = [`## [${ts}] ${entry.topic}`, `- proposal: ${oneLine(entry.proposal)}`];
	if (entry.userSaid) lines.push(`- userSaid: ${oneLine(entry.userSaid)}`);
	if (entry.decision) lines.push(`- decision: ${oneLine(entry.decision)}`);
	fs.appendFileSync(abs, `${lines.join("\n")}\n\n`);
	return { ts, ...entry };
}

export function resetDiscussion(entry: Omit<DiscussionEntry, "ts">): DiscussionEntry {
	const abs = discussionPath();
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, HEADER);
	return appendDiscussion(entry);
}

export function readDiscussion(): DiscussionEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(discussionPath(), "utf8");
	} catch {
		return [];
	}
	const entries: DiscussionEntry[] = [];
	// Blocks look like: "## [<iso>] <topic>" followed by "- key: value" lines.
	const re = /^## \[([^\]]+)\]\s*(.*)$/;
	let cur: DiscussionEntry | null = null;
	for (const line of text.split("\n")) {
		const m = re.exec(line);
		if (m) {
			if (cur) entries.push(cur);
			cur = { ts: m[1], topic: m[2].trim(), proposal: "" };
			continue;
		}
		if (!cur) continue;
		const kv = /^-\s*(proposal|userSaid|decision):\s*(.*)$/.exec(line);
		if (kv) {
			if (kv[1] === "proposal") cur.proposal = kv[2];
			else if (kv[1] === "userSaid") cur.userSaid = kv[2];
			else cur.decision = kv[2];
		}
	}
	if (cur) entries.push(cur);
	return entries;
}

export function discussionCount(): number {
	return readDiscussion().length;
}

/** Has the user been asked about (and answered on) a specific topic slug? */
export function hasDiscussionTopic(topic: string): boolean {
	return readDiscussion().some((e) => e.topic.toLowerCase() === topic.toLowerCase() && !!e.userSaid);
}

export function renderDiscussion(entries: DiscussionEntry[]): string {
	if (!entries.length) return "(none recorded — call wf_discuss to log what you and the user actually agreed)";
	return entries
		.map((e) => {
			const parts = [`[${e.ts}] ${e.topic}`, `  proposal: ${e.proposal}`];
			if (e.userSaid) parts.push(`  userSaid: ${e.userSaid}`);
			if (e.decision) parts.push(`  decision: ${e.decision}`);
			return parts.join("\n");
		})
		.join("\n");
}

function oneLine(s: string): string {
	return s.replace(/\r?\n/g, " ").trim();
}
