/**
 * The Jev decision call: one `/v1/systemone` request with a yes/no ("noul")
 * question per new context unit.
 *
 * The question asks whether this unit should be kept, with a bounded list of
 * concrete removal reasons to make Jev more decisive without discarding
 * durable context. A removal must match a reason; uncertainty still means keep.
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
	type: "noul" | "choice";
	instructions: string;
	criteria: Record<string, string>;
}

const KEEP_REASONS = [
	{ id: "instruction", label: "User instruction, preference, or constraint", description: "It records what the user asked for or how they want the work done." },
	{ id: "fact", label: "Unique fact, code, or useful result", description: "It contains information not safely recoverable from retained context." },
	{ id: "open-work", label: "Open task or unresolved question", description: "It is needed to continue unfinished work or answer an open question." },
	{ id: "summary", label: "Summary or durable context", description: "It summarizes prior work or preserves durable conversation context." },
	{ id: "future-use", label: "Plausibly useful later", description: "It may reasonably help a future response, or uncertainty favors keeping it." },
] as const;

const REMOVAL_REASONS = [
	{ id: "duplicate", label: "Duplicate of retained context", description: "The same information is already retained." },
	{ id: "superseded", label: "Superseded by newer information", description: "A newer complete correction or result replaces this unit." },
	{ id: "transient", label: "Transient chatter or coordination", description: "Acknowledgement, small talk, or coordination with no lasting preference or commitment." },
	{ id: "intermediate", label: "Redundant intermediate output", description: "Retry noise, routine progress, or verbose intermediate tool output whose useful result is already retained." },
	{ id: "completed", label: "Completed-task detail with no reusable value", description: "A completed-task detail containing no reusable fact, decision, instruction, code, or result." },
] as const;

type KeepReason = (typeof KEEP_REASONS)[number]["label"];
type RemovalReason = (typeof REMOVAL_REASONS)[number]["label"];
export type DecisionReason = KeepReason | RemovalReason | "No clear reason identified";

interface JevResponse {
	model?: string;
	answers?: Record<string, { type?: string; noul?: number; choice?: string }>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevDecision {
	/** Local indexes (into the `newUnits` array) that were actually judged. */
	judged: number[];
	/** Subset of `judged` to keep. */
	keep: Set<number>;
	/** Jev's most likely explanation for each judged unit's keep/remove decision. */
	reasons: Map<number, DecisionReason>;
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
	if (newUnits.length === 0) return { judged: [], keep: new Set(), reasons: new Map(), inputTokens: 0 };

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
				`Decide whether keeping this unit is likely to improve a future response enough to justify its context cost; ` +
				`a separate reason-classification pass will explain the decision. Reason from first principles rather than using ` +
				`a mechanical checklist. Ask: what future task could need this, does it change what the agent should do or say, ` +
				`is it durable or merely transient, is it unique or recoverable, and would removing it make the agent less ` +
				`accurate, consistent, or able to continue the work? Treat user intent, preferences, constraints, decisions, ` +
				`open questions, unresolved risks, unique facts, code/API details, useful results, caveats, and durable ` +
				`summaries as strong evidence of future value, not as labels that decide mechanically. ` +
				`Examples of often-useful context include: a user's chosen design direction, an API quirk discovered during ` +
				`debugging, a failing test and its root cause, a file format or schema, an unresolved trade-off, or a compact ` +
				`summary of decisions made earlier. Examples of often-low-value context include: greetings, acknowledgements, ` +
				`coordination chatter, repeated status updates, exact duplicates, retry noise, and verbose intermediate output ` +
				`when its conclusion and useful result are already retained. A stale detail may still matter if it records a ` +
				`decision or explains why the current implementation looks the way it does; a long message may be disposable ` +
				`if it is fully recoverable elsewhere. Prefer removal when the unit has little plausible future value and its ` +
				`loss is unlikely to change a future response. Prefer keeping when the consequences of removal are uncertain. ` +
				`These examples are guidance, not hard rules: use the meaning and role of this particular unit in the ongoing work.`,
			criteria: {
				true: "Keep this unit",
				false: "Remove this unit",
			},
		};
		// Jev supports mixed question types in one request. Keep the primary
		// noul authoritative and ask two native choice questions for explanations.
		questions[`why_keep_${i}`] = {
			type: "choice",
			instructions:
				`If the primary keep/remove decision for context unit [${i}] is to KEEP it, ` +
				`select the single best reason. Otherwise select "not-applicable".`,
			criteria: {
				...Object.fromEntries(KEEP_REASONS.map((reason) => [reason.id, `${reason.label}: ${reason.description}`])),
				"not-applicable": "The primary decision is to remove this unit.",
				unclear: "No clear keep reason identified.",
			},
		};
		questions[`why_remove_${i}`] = {
			type: "choice",
			instructions:
				`If the primary keep/remove decision for context unit [${i}] is to REMOVE it, select the best explanation ` +
				`of why its likely future value is low. Otherwise select "not-applicable". Choose a removal reason based on ` +
				`the unit's meaning in this work, not just its age, length, role, or wording.`,
			criteria: {
				...Object.fromEntries(REMOVAL_REASONS.map((reason) => [reason.id, `${reason.label}: ${reason.description}`])),
				"not-applicable": "The primary decision is to keep this unit.",
				unclear: "No clear removal reason identified.",
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
		const reasons = new Map<number, DecisionReason>();
		for (const i of selected) {
			const ans = data.answers[`u${i}`];
			const p = ans?.noul;
			// Keep on yes (>= threshold), and on any non-numeric/missing
			// answer: never discard on an undecided question.
			if (typeof p !== "number" || p >= cfg.threshold) keep.add(i);

			const options = keep.has(i) ? KEEP_REASONS : REMOVAL_REASONS;
			const choiceKey = keep.has(i) ? `why_keep_${i}` : `why_remove_${i}`;
			const choice = data.answers[choiceKey]?.choice;
			const selectedReason = options.find((option) => option.id === choice);
			reasons.set(i, selectedReason?.label ?? "No clear reason identified");
		}
		return { judged: selected, keep, reasons, inputTokens: data.usage?.input_tokens ?? 0 };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
