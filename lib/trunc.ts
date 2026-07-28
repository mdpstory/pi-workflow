/**
 * Terminal-width-aware line truncation for TUI components.
 *
 * Strips ANSI SGR escape sequences to measure visible width, then truncates
 * with ellipsis at the end so rendered lines never exceed the terminal width.
 */

import process from "node:process";

export const TUI_WIDTH = process.stdout.columns || 80;

export function truncLine(line: string, width: number): string {
	const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
	if (stripped.length <= width) return line;
	let visible = 0;
	let out = "";
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			let j = i + 2;
			while (j < line.length && line[j] !== "m") j++;
			out += line.slice(i, j + 1);
			i = j;
			continue;
		}
		if (visible >= width - 1) {
			out += "\u2026";
			break;
		}
		out += line[i];
		visible++;
	}
	return out;
}

export function truncateContent(content: string, width: number): string {
	return content
		.split("\n")
		.map((l) => truncLine(l, width))
		.join("\n");
}
