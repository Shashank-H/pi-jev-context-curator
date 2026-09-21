import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { RemovedContextEntry } from "./removed-context.ts";
import { formatTokens } from "./stats.ts";

const DEFAULT_BODY_ROWS = Math.max(10, Math.min(28, (process.stdout.rows ?? 30) - 10));

function repeat(char: string, count: number): string {
	return count > 0 ? char.repeat(count) : "";
}

function fitLine(content: string, width: number): string {
	const trimmed = truncateToWidth(content, width, "…");
	return trimmed + repeat(" ", Math.max(0, width - visibleWidth(trimmed)));
}

/** Scrollable popup for the context discarded during this pi session. */
export class RemovedContextDialog implements Component {
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly theme: Theme,
		private readonly entries: readonly RemovedContextEntry[],
		private readonly onClose: () => void,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private bodyLines(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const lines: string[] = [];
		for (const [index, entry] of this.entries.entries()) {
			lines.push(this.theme.fg("accent", `${index + 1}. ${entry.label}`));
			lines.push(
				this.theme.fg(
					"dim",
					`   ${entry.messageCount} message(s) • ~${formatTokens(entry.tokens)} tokens`,
				),
			);
			for (const sourceLine of entry.text.split("\n")) {
				lines.push(...wrapTextWithAnsi(sourceLine || " ", width));
			}
			if (index < this.entries.length - 1) lines.push("");
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(40, Math.min(width, 110));
		const innerWidth = dialogWidth - 2;
		const bodyLines = this.bodyLines(Math.max(10, innerWidth - 2));
		const maxBodyRows = DEFAULT_BODY_ROWS;
		const maxScrollOffset = Math.max(0, bodyLines.length - maxBodyRows);
		this.scrollOffset = Math.min(this.scrollOffset, maxScrollOffset);
		const visible = bodyLines.slice(this.scrollOffset, this.scrollOffset + maxBodyRows);
		const border = this.theme.fg("border", "│");
		const horizontal = this.theme.fg("border", "─".repeat(innerWidth));
		const lines = [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			`${border}${fitLine(this.theme.fg("accent", "Removed context"), innerWidth)}${border}`,
			`${border}${fitLine(this.theme.fg("dim", `${this.entries.length} unit(s) • session-scoped`), innerWidth)}${border}`,
			`${border}${horizontal}${border}`,
		];
		for (let i = 0; i < maxBodyRows; i++) {
			lines.push(`${border} ${fitLine(visible[i] ?? "", innerWidth - 2)} ${border}`);
		}
		const position = bodyLines.length === 0 ? "empty" : `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxBodyRows, bodyLines.length)} of ${bodyLines.length}`;
		lines.push(`${border}${fitLine(this.theme.fg("dim", `↑/↓ scroll • PgUp/PgDn • Home/End • q/Esc close   ${position}`), innerWidth)}${border}`);
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onClose();
			return;
		}
		const pageSize = DEFAULT_BODY_ROWS;
		if (matchesKey(data, Key.up)) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (matchesKey(data, Key.down)) this.scrollOffset += 1;
		else if (matchesKey(data, Key.pageUp)) this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
		else if (matchesKey(data, Key.pageDown)) this.scrollOffset += pageSize;
		else if (matchesKey(data, Key.home)) this.scrollOffset = 0;
		else if (matchesKey(data, Key.end)) this.scrollOffset = Number.MAX_SAFE_INTEGER;
		else return;
		this.invalidate();
	}
}
