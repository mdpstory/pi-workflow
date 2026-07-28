/**
 * Subagent tool — display/formatting helpers.
 *
 * Pure functions used by tool.ts to render tool-call previews, token/usage
 * summaries, and live-streaming diff previews. No process/env/spawn logic
 * here — see run.ts for that.
 */

import * as os from "node:os";
import * as path from "node:path";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { truncateContent, tuiWidth } from "../lib/trunc.ts";
import type { SingleResult } from "./run.ts";

function T(content: string): Text {
	return new Text(truncateContent(content, tuiWidth()), 0, 0);
}
function M(content: string, mdTheme: any): Markdown {
	return new Markdown(truncateContent(content, tuiWidth()), 0, 0, mdTheme);
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/**
 * Best-effort extraction of a string field's value from a possibly-incomplete
 * JSON object being streamed token-by-token (e.g. `{"path":"a.txt","content":"line1\nli`).
 * Returns whatever has been unescaped so far; stops safely at a dangling escape
 * instead of throwing on invalid JSON.
 */
export function extractPartialStringField(raw: string, field: string): string | undefined {
	const marker = `"${field}":"`;
	const start = raw.indexOf(marker);
	if (start === -1) return undefined;
	let i = start + marker.length;
	let out = "";
	while (i < raw.length) {
		const ch = raw[i];
		if (ch === "\\") {
			const next = raw[i + 1];
			if (next === undefined) break; // dangling escape at buffer end, stop safely
			if (next === "u") {
				const hex = raw.slice(i + 2, i + 6);
				if (hex.length < 4) break; // incomplete unicode escape
				out += String.fromCharCode(Number.parseInt(hex, 16));
				i += 6;
				continue;
			}
			const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/" };
			out += map[next] ?? next;
			i += 2;
			continue;
		}
		if (ch === '"') break; // reached the closing quote — field complete
		out += ch;
		i++;
	}
	return out;
}

export function langForPath(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		py: "python",
		rb: "ruby",
		go: "go",
		rs: "rust",
		java: "java",
		json: "json",
		md: "markdown",
		sh: "bash",
		yml: "yaml",
		yaml: "yaml",
	};
	return map[ext] ?? ext ?? "";
}

/** Simple line-based diff (LCS-free, longest-common-prefix/suffix trim) good enough for a live preview. */
export function simpleDiffLines(oldText: string, newText: string): string[] {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let endOld = oldLines.length;
	let endNew = newLines.length;
	while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
		endOld--;
		endNew--;
	}
	const out: string[] = [];
	for (let i = start; i < endOld; i++) out.push(`- ${oldLines[i]}`);
	for (let i = start; i < endNew; i++) out.push(`+ ${newLines[i]}`);
	return out;
}

/** Renders the full code content / diff for a completed write or edit tool call (not just a filename summary). */
export function renderToolCallDetail(
	name: string,
	args: Record<string, any>,
	theme: any,
	mdTheme: any,
): Array<Text | Markdown> {
	const out: Array<Text | Markdown> = [];
	if (name === "write") {
		const filePath = (args.file_path || args.path || "") as string;
		const content = (args.content ?? "") as string;
		if (content) out.push(M(`\`\`\`${langForPath(filePath)}\n${content}\n\`\`\``, mdTheme));
	} else if (name === "edit") {
		const oldText = (args.old_text || args.oldText || "") as string;
		const newText = (args.new_text || args.newText || "") as string;
		if (oldText || newText) {
			const lines = simpleDiffLines(oldText, newText).map((l) =>
				l.startsWith("+") ? theme.fg("success", l) : l.startsWith("-") ? theme.fg("error", l) : l,
			);
			if (lines.length) out.push(T(lines.join("\n")));
		}
	}
	return out;
}

/** Renders the in-progress tool call / text the model is currently streaming, word-by-word. */
export function renderLiveBlock(r: SingleResult, theme: any, mdTheme: any): Array<Text | Markdown> {
	const out: Array<Text | Markdown> = [];
	if (r.liveToolCall) {
		const { name, rawArgs } = r.liveToolCall;
		out.push(T(theme.fg("muted", "→ ") + theme.fg("accent", name) + theme.fg("dim", " (writing...)")));
		if (name === "write") {
			const content = extractPartialStringField(rawArgs, "content");
			if (content) {
				const filePath =
					extractPartialStringField(rawArgs, "file_path") ?? extractPartialStringField(rawArgs, "path") ?? "";
				out.push(M(`\`\`\`${langForPath(filePath)}\n${content}▌\n\`\`\``, mdTheme));
			}
		} else if (name === "edit") {
			const newText = extractPartialStringField(rawArgs, "new_text") ?? extractPartialStringField(rawArgs, "newText");
			if (newText) {
				const lines = newText
					.split("\n")
					.map((l) => theme.fg("success", `+ ${l}`))
					.join("\n");
				out.push(T(`${lines}${theme.fg("dim", "▌")}`));
			}
		}
	}
	return out;
}
