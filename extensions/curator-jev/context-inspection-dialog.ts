import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ContextInspectionEntry } from "./context-inspection.ts";
import { formatTokens } from "./stats.ts";
import type { CacheGraphView, CacheHitMetric } from "./cache-graph.ts";
import { renderCacheGraph } from "./cache-graph.ts";

const DEFAULT_BODY_ROWS = Math.max(10, Math.min(28, (process.stdout.rows ?? 30) - 10));
function repeat(char: string, count: number): string { return count > 0 ? char.repeat(count) : ""; }
function fitLine(content: string, width: number): string {
	const trimmed = truncateToWidth(content, width, "…");
	return trimmed + repeat(" ", Math.max(0, width - visibleWidth(trimmed)));
}

/** Two-tab session popup: inspected context decisions and provider cache hit ratio. */
export class ContextInspectionDialog implements Component {
	private scrollOffset = 0;
	private selectedIndex = 0;
	private expandedIndex?: number;
	private tab: "inspect" | "cache" = "inspect";
	private cacheView: CacheGraphView = "per-turn";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly theme: Theme,
		private readonly entries: readonly ContextInspectionEntry[],
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
			const entries = [...this.entries].reverse();
			lines = [];
			// Keep the list compact: one summary row per removed unit. Details are
			// rendered only for the selected entry when the user presses Enter.
			for (const [index, entry] of entries.entries()) {
				const pointer = index === this.selectedIndex ? "›" : " ";
				const summary = `${pointer} ${index + 1}. ${entry.kept ? "✓ kept" : "× removed"} ${entry.label} — ${entry.messageCount} message(s) • ~${formatTokens(entry.tokens)} tokens • ${entry.reason ?? "No clear reason identified"}`;
				lines.push(this.theme.fg(index === this.selectedIndex ? "accent" : "dim", summary));
				if (this.expandedIndex === index) {
					lines.push(this.theme.fg("dim", "  Details:"));
					for (const sourceLine of entry.text.split("\n")) lines.push(...wrapTextWithAnsi(`  ${sourceLine || " "}`, width));
				}
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
			`${border}${fitLine(this.theme.fg("accent", "Jev inspection dashboard"), innerWidth)}${border}`,
			`${border}${fitLine(this.tab === "inspect" ? this.theme.fg("accent", "[1] Inspect context") + "  [2] Cache hit ratio" : "[1] Inspect context  " + this.theme.fg("accent", "[2] Cache hit ratio"), innerWidth)}${border}`,
			`${border}${fitLine(this.theme.fg("border", "─".repeat(innerWidth)), innerWidth)}${border}`,
		];
		for (let i = 0; i < DEFAULT_BODY_ROWS; i++) lines.push(`${border} ${fitLine(visible[i] ?? "", innerWidth - 2)} ${border}`);
		const position = `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + DEFAULT_BODY_ROWS, bodyLines.length)} of ${bodyLines.length}`;
		const cacheHelp = this.tab === "cache" ? " • v cycle chart" : "";
		const removedHelp = this.tab === "inspect" ? " • Enter expand" : "";
		lines.push(`${border}${fitLine(this.theme.fg("dim", `←/→ or 1/2 tabs${removedHelp}${cacheHelp} • ↑/↓ scroll • PgUp/PgDn • q/Esc close   ${position}`), innerWidth)}${border}`);
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.onClose();
		if (data === "1" || data === "2" || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			this.tab = data === "1" || matchesKey(data, Key.left) ? "inspect" : "cache";
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
		if (this.tab === "inspect" && (matchesKey(data, Key.enter) || data === "\r" || data === "\n")) {
			this.expandedIndex = this.expandedIndex === this.selectedIndex ? undefined : this.selectedIndex;
			this.scrollOffset = 0;
			this.invalidate();
			return;
		}
		const pageSize = DEFAULT_BODY_ROWS;
		const entryCount = this.entries.length;
		if (this.tab === "inspect" && entryCount > 0 && matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.expandedIndex = undefined;
			this.scrollOffset = 0;
		} else if (this.tab === "inspect" && entryCount > 0 && matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(entryCount - 1, this.selectedIndex + 1);
			this.expandedIndex = undefined;
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.up)) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (matchesKey(data, Key.down)) this.scrollOffset += 1;
		else if (matchesKey(data, Key.pageUp)) this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
		else if (matchesKey(data, Key.pageDown)) this.scrollOffset += pageSize;
		else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
			this.expandedIndex = undefined;
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = Math.max(0, entryCount - 1);
			this.expandedIndex = undefined;
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
		} else return;
		this.invalidate();
	}
}
