/**
 * The classifier.dev judge backend: keyless zero-shot classification over
 * plain HTTP (https://classifier.dev), itself powered by Jev.
 *
 * Same contract as askJev: judge each new unit keep/discard and return which
 * were judged and which to keep, or null on any failure — the caller must
 * fail open (keep everything, record nothing) when this returns null.
 *
 * Unlike the Jev backend, each judgment here is independent (no transcript
 * passed as shared state), so every input carries the current request as an
 * anchor — "will a future response need this?" is relative to what the
 * conversation is about.
 *
 * No API key is needed. The tradeoff: unit text is sent to a third-party
 * service (never stored or logged there; forwarded to the model provider
 * for the classification only). inputTokens is always 0 — the service is
 * free, so session cost stays $0.
 */

import {
	CLASSIFIER_TIMEOUT_MS,
	CLASSIFIER_URL,
	MAX_UNIT_CHARS,
	type CuratorConfig,
} from "./config.ts";
import { type Unit } from "./units.ts";
import type { JevDecision } from "./jev.ts";

const KEEP = "keep";
const DISCARD = "discard";

interface ClassifierResult {
	label?: string;
	confidence?: number | null;
	scores?: Record<string, number>;
}

interface ClassifierResponse {
	results?: ClassifierResult[];
}

/** Probability the unit should be kept, or null when the answer is undecided. */
function keepProbability(r: ClassifierResult): number | null {
	const s = r.scores?.[KEEP];
	if (typeof s === "number") return Math.min(1, Math.max(0, s));
	if (typeof r.confidence === "number" && typeof r.label === "string") {
		return r.label === KEEP ? r.confidence : 1 - r.confidence;
	 }
	return null; // unscored input etc: fail-safe keep
}

function truncate(s: string, maxChars: number): string {
	return s.length > maxChars ? s.slice(0, maxChars) + "\n…[truncated]" : s;
}

/**
 * Ask classifier.dev which of the new units any future response might need.
 * `anchorText` is the current request (the latest, never-judged unit).
 * Returns the decision, or `null` on any failure — the caller must fail
 * open when this returns null.
 */
export async function askClassifier(
	newUnits: Unit[],
	anchorText: string,
	cfg: CuratorConfig,
	signal: AbortSignal | undefined,
): Promise<JevDecision | null> {
	if (newUnits.length === 0) return { judged: [], keep: new Set(), inputTokens: 0 };

	const anchor = truncate(anchorText, MAX_UNIT_CHARS);
	const inputs = newUnits.map(
		(u) =>
			`Current request:\n${anchor}\n\n---\n\nContext unit to judge (${u.label}):\n${truncate(u.text, MAX_UNIT_CHARS)}`,
	);

	const ctrl = new AbortController();
	const timer = setTimeout(
		() => ctrl.abort(new Error("classifier.dev request timed out")),
		CLASSIFIER_TIMEOUT_MS,
	);
	try {
		if (signal?.aborted) ctrl.abort(signal.reason);
		else signal?.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });

		const res = await fetch(CLASSIFIER_URL, {
			method: "POST",
			signal: ctrl.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				inputs,
				labels: [KEEP, DISCARD],
				instructions:
					`Decide whether ANY future response in this conversation will likely need the "Context unit to judge" below, ` +
					`given the "Current request". A "discard" verdict PERMANENTLY removes the unit, so judge "keep" whenever ` +
					`there is any plausible future need: task instructions, facts, file contents, code, or tool results a later ` +
					`response may depend on. Judge "discard" only if no future response could need it.`,
				tier: cfg.classifierTier,
			}),
		});

		if (!res.ok) {
			if (res.status === 429) return null; // rate-limited: fail open
			throw new Error(`classifier.dev returned HTTP ${res.status}`);
		}
		const data = (await res.json()) as ClassifierResponse;
		if (!Array.isArray(data.results) || data.results.length !== inputs.length) {
			throw new Error("classifier.dev returned an unexpected response shape");
		}

		const keep = new Set<number>();
		const judged: number[] = [];
		data.results.forEach((r, i) => {
			judged.push(i);
			const p = keepProbability(r);
			// Keep on a keep verdict (>= threshold), and on any undecided
			// answer: never discard on an undecided question.
			if (p === null || p >= cfg.threshold) keep.add(i);
		});
		return { judged, keep, inputTokens: 0 };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
