/** Session-scoped tracking of Jev API usage and estimated cost. */

import { JEV_USD_PER_MTOK_INPUT } from "./config.ts";

export interface SessionStats {
	calls: number;
	inputTokens: number;
	costUsd: number;
	lastCallCostUsd: number;
	lastCallTokens: number;
}

export function createStats(): SessionStats {
	return { calls: 0, inputTokens: 0, costUsd: 0, lastCallCostUsd: 0, lastCallTokens: 0 };
}

/**
 * Record one Jev call. Only input tokens are billed (outputs are free).
 * Returns the estimated cost of this call in USD.
 */
export function recordCall(stats: SessionStats, inputTokens: number): number {
	const callCost = (inputTokens / 1_000_000) * JEV_USD_PER_MTOK_INPUT;
	stats.calls += 1;
	stats.inputTokens += inputTokens;
	stats.costUsd += callCost;
	stats.lastCallCostUsd = callCost;
	stats.lastCallTokens = inputTokens;
	return callCost;
}

export function formatUsd(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(6)}`;
	return `$${n.toFixed(4)}`;
}
