/**
 * Terminal-width-aware line truncation for TUI components.
 *
 * Delegates to pi-tui's truncateToWidth which correctly measures
 * visible width including CJK, emoji, and all ANSI sequences.
 */

import process from "node:process";
import { truncateToWidth } from "@earendil-works/pi-tui";

export function tuiWidth(): number {
	return process.stdout.columns || 80;
}

export function truncLine(line: string, width: number): string {
	return truncateToWidth(line, width, "\u2026");
}

export function truncateContent(content: string, width: number): string {
	return content
		.split("\n")
		.map((l) => truncateToWidth(l, width, "\u2026"))
		.join("\n");
}
