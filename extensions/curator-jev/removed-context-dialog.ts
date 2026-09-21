import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { RemovedContextEntry } from "./removed-context.ts";
import { formatTokens } from "./stats.ts";
import type { CacheGraphView, CacheHitMetric } from "./cache-graph.ts";
import { renderCacheGraph } from "./cache-graph.ts";

const DEFAULT_BODY_ROWS = Math.max(10, Math.min(28, (process.stdout.rows ?? 30) - 10));
function repeat(char: string, count: number): string { return count > 0 ? char.repeat(count) : ""; }
function fitLine(content: string, width: number): string {
	const trimmed = truncateToWidth(content, width, "…");
	return trimmed + repeat(" ", Math.max(0, width - visibleWidth(trimmed)));
}

/** Two-tab session popup: discarded context and provider cache hit ratio. */
export class RemovedContextDialog implements Component {
	private scrollOffset = 0;
	private tab: "removed" | "cache" = "removed";
	private cacheView: CacheGraphView = "per-turn";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly theme: Theme,
		private readonly entries: readonly RemovedContextEntry[],
		private readonly cacheMetrics: readonly CacheHitMetric[],
		private readonly onClose: () => void,
	) {}

	invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }

	private bodyLines(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		let lines: string[];
		if (this.tab === "cache") {
			lines = renderCacheGraph(this.cacheMetrics, width, (s) => this.theme.fg("accent", s), (s) => this.theme.fg("dim", s), this.cacheView);
		} else {
			lines = [];
			for (const [index, entry] of this.entries.entries()) {
				lines.push(this.theme.fg("accent", `${index + 1}. ${entry.label}`));
				lines.push(this.theme.fg("dim", `   ${entry.messageCount} message(s) • ~${formatTokens(entry.tokens)} tokens`));
				for (const sourceLine of entry.text.split("\n")) lines.push(...wrapTextWithAnsi(sourceLine || " ", width));
				if (index < this.entries.length - 1) lines.push("");
			}
			if (lines.length === 0) lines.push(this.theme.fg("dim", "No context has been removed in this session."));
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(40, Math.min(width, 110));
		const innerWidth = dialogWidth - 2;
		const bodyLines = this.bodyLines(Math.max(10, innerWidth - 2));
		const maxScrollOffset = Math.max(0, bodyLines.length - DEFAULT_BODY_ROWS);
		this.scrollOffset = Math.min(this.scrollOffset, maxScrollOffset);
		const visible = bodyLines.slice(this.scrollOffset, this.scrollOffset + DEFAULT_BODY_ROWS);
		const border = this.theme.fg("border", "│");
		const lines = [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			`${border}${fitLine(this.theme.fg("accent", "Jev session dashboard"), innerWidth)}${border}`,
			`${border}${fitLine(this.tab === "removed" ? this.theme.fg("accent", "[1] Removed context") + "  [2] Cache hit ratio" : "[1] Removed context  " + this.theme.fg("accent", "[2] Cache hit ratio"), innerWidth)}${border}`,
			`${border}${fitLine(this.theme.fg("border", "─".repeat(innerWidth)), innerWidth)}${border}`,
		];
		for (let i = 0; i < DEFAULT_BODY_ROWS; i++) lines.push(`${border} ${fitLine(visible[i] ?? "", innerWidth - 2)} ${border}`);
		const position = `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + DEFAULT_BODY_ROWS, bodyLines.length)} of ${bodyLines.length}`;
		const cacheHelp = this.tab === "cache" ? " • v cycle chart" : "";
		lines.push(`${border}${fitLine(this.theme.fg("dim", `←/→ or 1/2 tabs${cacheHelp} • ↑/↓ scroll • PgUp/PgDn • q/Esc close   ${position}`), innerWidth)}${border}`);
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.onClose();
		if (data === "1" || data === "2" || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			this.tab = data === "1" || matchesKey(data, Key.left) ? "removed" : "cache";
			this.scrollOffset = 0;
			this.invalidate();
			return;
		}
		if (this.tab === "cache" && data === "v") {
			this.cacheView = this.cacheView === "per-turn" ? "cumulative-percent" : this.cacheView === "cumulative-percent" ? "cumulative-total" : "per-turn";
			this.scrollOffset = 0;
			this.invalidate();
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
