/**
 * The Jev decision call: one `/v1/systemone` request with a yes/no ("noul")
 * question per context unit — "will the next response likely need this unit?"
 *
 * Uses plain `fetch` (not pi's model registry) so it never re-triggers
 * `context` handlers — no recursion.
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
	/** Unit indexes to keep (as indexes into the `units` array). */
	keep: Set<number>;
	inputTokens: number;
}

function truncate(s: string, maxChars: number): string {
	return s.length > maxChars ? s.slice(0, maxChars) + "\n…[truncated]" : s;
}

/**
 * Ask Jev which units are likely needed for the next LLM response.
 * Returns the decision, or `null` on any failure — the caller must fail
 * open (keep everything) when this returns null.
 */
export async function askJev(
	units: Unit[],
	/** Unit indexes Jev is allowed to judge (excludes always-keep units). */
	decidable: number[],
	apiKey: string,
	cfg: CuratorConfig,
	signal: AbortSignal | undefined,
): Promise<JevDecision | null> {
	// Build the numbered transcript as Jev's `state`. Question keys are not
	// sent to the model, so each question's instructions name its unit number.
	const lines = units.map((u, i) => `[${i}] (${u.label})\n${truncate(u.text, MAX_UNIT_CHARS)}`);

	// Enforce Jev's state token budget: drop the *oldest* decidable units from
	// the decision set (they are kept, not dropped).
	let stateText = lines.join("\n\n");
	const keep = new Set<number>(units.map((_, i) => i).filter((i) => !decidable.includes(i)));
	const active = [...decidable];
	while (active.length > 0 && estimateTokens(stateText) > MAX_STATE_TOKENS) {
		const dropped = active.shift()!;
		keep.add(dropped);
		stateText = active.map((i) => lines[i]).join("\n\n");
	}
	if (active.length === 0) return { keep, inputTokens: 0 };

	const questions: Record<string, JevQuestion> = {};
	for (const i of active) {
		questions[`u${i}`] = {
			type: "noul",
			instructions:
				`Consider ONLY context unit [${i}] (${units[i].label}) in the transcript above. ` +
				`Will the assistant's next response likely need the content of unit [${i}]? ` +
				`Answer yes if it holds task instructions, facts, file contents, code, or tool results the next response may depend on. ` +
				`Answer no only if the next response can clearly be produced without it.`,
			criteria: {
				true: "The next response likely depends on this unit's content",
				false: "The next response can be produced without this unit",
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

		for (const i of active) {
			const ans = data.answers[`u${i}`];
			const p = ans?.noul;
			if (typeof p === "number" && p >= cfg.threshold) keep.add(i);
			// Non-numeric/missing answer -> drop nothing: keep the unit.
			else if (typeof p !== "number") keep.add(i);
		}
		return { keep, inputTokens: data.usage?.input_tokens ?? 0 };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
