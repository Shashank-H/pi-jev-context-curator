/**
 * The Jev decision call: one `/v1/systemone` request with a yes/no ("noul")
 * question per new context unit.
 *
 * The question is framed for permanent removal: "will ANY future response in
 * this conversation need this unit?" A "no" means the unit is discarded for
 * good, so the bar for answering no is high and the safe direction on
 * uncertainty is to keep.
 *
 * Only units after the checkpoint are sent: Jev never sees the same unit
 * twice. Uses plain `fetch` (not pi's model registry) so it never
 * re-triggers `context` handlers — no recursion.
 */

import {
	JEV_TIMEOUT_MS,
	MAX_STATE_TOKENS,
	MAX_UNIT_CHARS,
	type CuratorConfig,
} from "./config.ts";
import { estimateTokens, type Unit } from "./units.ts";

interface JevQuestion {
	type: "noul";
	instructions: string;
	criteria?: { true: string; false: string };
}

interface JevResponse {
	model?: string;
	answers?: Record<string, { type?: string; noul?: number }>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevDecision {
	/** Local indexes (into the `newUnits` array) that were actually judged. */
	judged: number[];
	/** Subset of `judged` to keep. */
	keep: Set<number>;
	inputTokens: number;
}

function truncate(s: string, maxChars: number): string {
	return s.length > maxChars ? s.slice(0, maxChars) + "\n…[truncated]" : s;
}

/**
 * Ask Jev which of the new units any future response might need.
 * Returns the decision, or `null` on any failure — the caller must fail
 * open (keep everything, record nothing) when this returns null.
 *
 * Units that do not fit Jev's state token budget are left out of `judged`
 * so the caller leaves them unjudged for the next event instead of
 * permanently keeping them without a decision.
 */
export async function askJev(
	newUnits: Unit[],
	apiKey: string,
	cfg: CuratorConfig,
	signal: AbortSignal | undefined,
): Promise<JevDecision | null> {
	if (newUnits.length === 0) return { judged: [], keep: new Set(), inputTokens: 0 };

	const lines = newUnits.map((u, i) => `[${i}] (${u.label})\n${truncate(u.text, MAX_UNIT_CHARS)}`);

	// Newest units first within the state budget; the rest stay unjudged
	// for the next event. The newest unit is always included so we make
	// progress even if a single unit exceeds the budget on its own.
	const maxChars = MAX_STATE_TOKENS * 4;
	const selected: number[] = [];
	let used = 0;
	for (let i = newUnits.length - 1; i >= 0; i--) {
		if (selected.length > 0 && used + lines[i].length > maxChars) break;
		used += lines[i].length;
		selected.unshift(i);
	}
	const stateText = selected.map((i) => lines[i]).join("\n\n");

	const questions: Record<string, JevQuestion> = {};
	for (const i of selected) {
		questions[`u${i}`] = {
			type: "noul",
			instructions:
				`Consider ONLY context unit [${i}] (${newUnits[i].label}) in the transcript above. ` +
				`Is this context unit likely ESSENTIAL to completing a future response in this conversation? ` +
				`Keep it only if a later response is likely to directly depend on its unique instructions, facts, ` +
				`file contents, code, or tool results. Do NOT keep it merely because it provides background, ` +
				`might be useful, or could possibly become relevant. Prefer discarding transient reasoning, ` +
				`intermediate tool output, already-summarized information, and redundant context. ` +
				`When uncertain, answer no.`,
			criteria: {
				true: "This unit is likely essential to a future response — keep it",
				false: "This unit is not essential or is uncertain — permanently discard it",
			},
		};
	}

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("Jev request timed out")), JEV_TIMEOUT_MS);
	try {
		if (signal?.aborted) ctrl.abort(signal.reason);
		else signal?.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });

		const res = await fetch(`${cfg.baseUrl}/v1/systemone`, {
			method: "POST",
			signal: ctrl.signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ state: stateText, model: cfg.model, questions }),
		});

		if (!res.ok) {
			if (res.status === 429 || res.status === 529) return null; // rate-limited/overloaded: fail open
			throw new Error(`Jev API returned HTTP ${res.status}`);
		}
		const data = (await res.json()) as JevResponse;
		if (!data.answers) throw new Error("Jev response had no answers");

		const keep = new Set<number>();
		for (const i of selected) {
			const ans = data.answers[`u${i}`];
			const p = ans?.noul;
			// Keep on yes (>= threshold), and on any non-numeric/missing
			// answer: never discard on an undecided question.
			if (typeof p !== "number" || p >= cfg.threshold) keep.add(i);
		}
		return { judged: selected, keep, inputTokens: data.usage?.input_tokens ?? 0 };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
