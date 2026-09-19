/** Session-scoped tracking of Jev API usage, estimated cost, and removals. */

import { JEV_USD_PER_MTOK_INPUT, TAG } from "./config.ts";

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

/** Compact token count: 31000 -> "31k", 1500 -> "1.5k". */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	const k = n / 1000;
	return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

export interface RemovalStats {
	/** Units Jev has judged this session. */
	unitsJudged: number;
	/** Units permanently discarded (counted once, at judgment time). */
	unitsRemoved: number;
	messagesRemoved: number;
	tokensRemoved: number;
	/** Cumulative context volume removed across all curation passes this session. */
	sessionSavedMessages: number;
	sessionSavedTokens: number;
	/** Last curation pass: totals, removed, and kept for the current context. */
	lastTotalMessages: number;
	lastTotalTokens: number;
	lastRemovedMessages: number;
	lastRemovedTokens: number;
}

export function createRemovalStats(): RemovalStats {
	return {
		unitsJudged: 0,
		unitsRemoved: 0,
		messagesRemoved: 0,
		tokensRemoved: 0,
		sessionSavedMessages: 0,
		sessionSavedTokens: 0,
		lastTotalMessages: 0,
		lastTotalTokens: 0,
		lastRemovedMessages: 0,
		lastRemovedTokens: 0,
	};
}

/** Record newly judged units that were permanently discarded. */
export function recordDiscarded(
	r: RemovalStats,
	units: number,
	messages: number,
	tokens: number,
): void {
	r.unitsRemoved += units;
	r.messagesRemoved += messages;
	r.tokensRemoved += tokens;
}

/** Record the outcome of one curation pass over the current context. */
export function recordCuration(
	r: RemovalStats,
	judgedUnits: number,
	totalMessages: number,
	totalTokens: number,
	removedMessages: number,
	removedTokens: number,
): void {
	r.unitsJudged += judgedUnits;
	r.sessionSavedMessages += removedMessages;
	r.sessionSavedTokens += removedTokens;
	r.lastTotalMessages = totalMessages;
	r.lastTotalTokens = totalTokens;
	r.lastRemovedMessages = removedMessages;
	r.lastRemovedTokens = removedTokens;
}

export function formatStatsSummary(cost: SessionStats, r: RemovalStats, backend = "jev"): string {
	const keptMessages = r.lastTotalMessages - r.lastRemovedMessages;
	const keptTokens = r.lastTotalTokens - r.lastRemovedTokens;
	return (
		`[${TAG}] session stats\n` +
		`  judged: ${r.unitsJudged} units (${r.unitsJudged - r.unitsRemoved} kept, ${r.unitsRemoved} removed)\n` +
		`  cumulative removed: ${r.sessionSavedMessages} messages (~${formatTokens(r.sessionSavedTokens)} tokens)\n` +
		`  discarded by new judgments: ${r.messagesRemoved} messages (~${formatTokens(r.tokensRemoved)} tokens)\n` +
		`  last context: ${r.lastTotalMessages} messages (~${formatTokens(r.lastTotalTokens)} tokens) ` +
		`-> kept ${keptMessages} (~${formatTokens(keptTokens)})\n` +
		`  ${backend}: ${cost.calls} calls, ${cost.inputTokens.toLocaleString()} input tokens, cost ${formatUsd(cost.costUsd)}`
	);
}
