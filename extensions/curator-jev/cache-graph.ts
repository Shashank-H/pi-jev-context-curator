import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type CacheGraphView = "per-turn" | "cumulative-percent" | "cumulative-total";

export interface CacheHitMetric {
	sequence: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	hitPercent: number;
}

/** The canonical pi-cache-graph formula: cache reads / the full prompt size. */
export function cacheHitPercent(input: number, cacheRead: number, cacheWrite: number): number {
	const promptTokens = input + cacheRead + cacheWrite;
	return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
}

export function collectCacheMetrics(entries: readonly SessionEntry[]): CacheHitMetric[] {
	const metrics: CacheHitMetric[] = [];
	let sequence = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.usage) continue;
		const { input, cacheRead, cacheWrite } = entry.message.usage;
		metrics.push({
			sequence: ++sequence,
			input,
			cacheRead,
			cacheWrite,
			hitPercent: cacheHitPercent(input, cacheRead, cacheWrite),
		});
	}
	return metrics;
}

function bar(value: number, max: number, width: number): string {
	const filled = Math.round((Math.max(0, Math.min(max, value)) / max) * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function totals(metrics: readonly CacheHitMetric[]) {
	return metrics.reduce(
		(total, metric) => ({
			input: total.input + metric.input,
			cacheRead: total.cacheRead + metric.cacheRead,
			cacheWrite: total.cacheWrite + metric.cacheWrite,
		}),
		{ input: 0, cacheRead: 0, cacheWrite: 0 },
	);
}

function viewLabel(view: CacheGraphView): string {
	return view === "per-turn" ? "Per-turn (%)" : view === "cumulative-percent" ? "Cumulative (%)" : "Cumulative (total)";
}

/**
 * Plot turns left-to-right, like the cache graph used by the reference
 * implementation. Each column is one assistant turn; the y-axis is hit rate.
 */
function horizontalPercentGraph(
	values: readonly { sequence: number; percent: number }[],
	color: (s: string) => string,
	dim: (s: string) => string,
): string[] {
	const levels = [100, 75, 50, 25, 0];
	const axis = values.map(({ percent }) => Math.max(0, Math.min(100, percent)));
	const rows = levels.map((level) => {
		const marks = axis.map((percent) => percent >= level ? "█" : "·").join(" ");
		return `${dim(`${String(level).padStart(3)}%`)} │ ${color(marks)}`;
	});
	const labels = values.map(({ sequence }) => String(sequence).padStart(2, " ")).join(" ");
	return [
		...rows,
		`${dim("    ")} └${"─".repeat(Math.max(1, labels.length + 1))}`,
		`${dim("    ")}  ${labels}`,
	];
}

/** Render the same three cache views exposed by pi-cache-graph. */
export function renderCacheGraph(
	metrics: readonly CacheHitMetric[],
	width: number,
	color: (s: string) => string,
	dim: (s: string) => string,
	view: CacheGraphView = "per-turn",
): string[] {
	if (metrics.length === 0) return [dim("No assistant usage metrics recorded in this session.")];
	const total = totals(metrics);
	const overall = cacheHitPercent(total.input, total.cacheRead, total.cacheWrite);
	const graphWidth = Math.max(10, Math.min(44, width - 26));
	const lines = [
		color(`Cache hit ratio — ${viewLabel(view)}`),
		`${dim("Overall")}: ${overall.toFixed(1)}%  ${color(bar(overall, 100, graphWidth))}`,
		`${dim("Totals")}: input ${total.input.toLocaleString()} • cacheWrite ${total.cacheWrite.toLocaleString()} • cacheRead ${total.cacheRead.toLocaleString()}`,
		`${dim("Formula")}: cacheRead / (input + cacheRead + cacheWrite)`,
		"",
	];
	const visible = metrics.slice(-Math.max(4, Math.min(18, (process.stdout.rows ?? 30) - 15)));
	if (view === "per-turn") {
		lines.push(color("Per-turn cache hit % (turns →)"));
		lines.push(...horizontalPercentGraph(
			visible.map((metric) => ({ sequence: metric.sequence, percent: metric.hitPercent })),
			color,
			dim,
		));
	} else if (view === "cumulative-percent") {
		lines.push(color("Running aggregate cache hit % (turns →)"));
		let running = { input: 0, cacheRead: 0, cacheWrite: 0 };
		const values = visible.map((metric) => {
			running = { input: running.input + metric.input, cacheRead: running.cacheRead + metric.cacheRead, cacheWrite: running.cacheWrite + metric.cacheWrite };
			return { sequence: metric.sequence, percent: cacheHitPercent(running.input, running.cacheRead, running.cacheWrite) };
		});
		lines.push(...horizontalPercentGraph(values, color, dim));
	} else {
		lines.push(color("Running cumulative token volumes"));
		const cumulative = { input: 0, cacheRead: 0, cacheWrite: 0 };
		const max = Math.max(...visible.map((metric) => {
			cumulative.input += metric.input;
			cumulative.cacheRead += metric.cacheRead;
			cumulative.cacheWrite += metric.cacheWrite;
			return cumulative.input + cumulative.cacheRead + cumulative.cacheWrite;
		}), 1);
		lines.push(dim("input ▇  cacheWrite ░  cacheRead ▒"));
		let running = { input: 0, cacheRead: 0, cacheWrite: 0 };
		for (const metric of visible) {
			running = { input: running.input + metric.input, cacheRead: running.cacheRead + metric.cacheRead, cacheWrite: running.cacheWrite + metric.cacheWrite };
			const totalWidth = Math.max(1, Math.round(graphWidth * (running.input + running.cacheRead + running.cacheWrite) / max));
			const inputWidth = Math.round(totalWidth * running.input / Math.max(1, running.input + running.cacheRead + running.cacheWrite));
			const writeWidth = Math.round(totalWidth * running.cacheWrite / Math.max(1, running.input + running.cacheRead + running.cacheWrite));
			lines.push(`${String(metric.sequence).padStart(3)} ${color("▇".repeat(inputWidth))}${dim("░".repeat(writeWidth))}${color("▒".repeat(Math.max(0, totalWidth - inputWidth - writeWidth)))} ${Math.round(running.input + running.cacheRead + running.cacheWrite).toLocaleString()}`);
		}
	}
	return lines;
}
