/**
 * Local "direct readout" backend (SemIf): answers Jev-style questions from a
 * llama.cpp `llama-server` by reading option-letter logprobs for ONE generated
 * token, softmaxed over just the allowed options (same method as openjev.com).
 * Local only: no key, loopback only, redirects refused.
 */

import { LOCAL_TIMEOUT_MS, type CuratorConfig } from "./config.ts";

export interface Question {
	type: "noul" | "choice";
	instructions: string;
	criteria: Record<string, string>;
}
export interface Answers {
	answers: Record<string, { type: string; noul?: number; choice?: string }>;
	usage: { input_tokens: number };
}

const letter = (i: number) => String.fromCharCode(65 + i);
const tokenIds = new Map<string, number | undefined>();
/** Token ids are per model: forget them when the server/model may have changed. */
export const clearTokenCache = (): void => tokenIds.clear();

async function post(cfg: CuratorConfig, path: string, body: unknown, signal: AbortSignal): Promise<any> {
	const res = await fetch(`${cfg.baseUrl}${path}`, {
		method: "POST",
		signal,
		redirect: "error",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** Token id of a bare option letter in the server's own vocab (needed for logit_bias). */
async function letterId(cfg: CuratorConfig, l: string, signal: AbortSignal): Promise<number | undefined> {
	const key = `${cfg.baseUrl}|${l}`;
	if (!tokenIds.has(key)) {
		const r = await post(cfg, "/tokenize", { content: l, add_special: false }, signal);
		tokenIds.set(key, Array.isArray(r.tokens) && r.tokens.length === 1 ? r.tokens[0] : undefined);
	}
	return tokenIds.get(key);
}

export function softmax(xs: number[]): number[] {
	const m = Math.max(...xs);
	const e = xs.map((x) => Math.exp(x - m));
	const t = e.reduce((a, b) => a + b, 0);
	return e.map((x) => x / t);
}

/** P(option i) for one question; throws if the server did not return every option's logprob. */
async function readout(
	cfg: CuratorConfig,
	state: string,
	instructions: string,
	options: string[],
	signal: AbortSignal,
): Promise<{ probs: number[]; tokens: number }> {
	const labels = options.map((_, i) => letter(i));
	const ids = await Promise.all(labels.map((l) => letterId(cfg, l, signal)));
	const r = await post(
		cfg,
		"/v1/chat/completions",
		{
			messages: [
				{ role: "system", content: "Make the requested decision from the supplied state. Follow the output format exactly." },
				{
					role: "user",
					content:
						`State:\n${state}\n\nQuestion:\n${instructions}\n\nAllowed options:\n` +
						`${options.map((o, i) => `${labels[i]}. ${o}`).join("\n")}\n\n` +
						`Reply with exactly one option letter from: ${labels.join(", ")}.`,
				},
			],
			max_tokens: 1,
			temperature: 1,
			top_k: 0,
			top_p: 1,
			logprobs: true,
			top_logprobs: 20,
			// Force the letters into the reported top-k even when the model prefers other tokens.
			logit_bias: Object.fromEntries(ids.filter((x) => x !== undefined).map((id) => [String(id), 100])),
			grammar: `root ::= ${labels.map((l) => `"${l}"`).join(" | ")}`,
			cache_prompt: true, // state is the shared prefix across questions
			chat_template_kwargs: { enable_thinking: false },
		},
		signal,
	);
	const top: { token: string; logprob: number }[] = r.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
	const lps = labels.map((l) => Number(top.find((t) => t.token === l)?.logprob));
	if (lps.some((x) => !Number.isFinite(x))) throw new Error("server did not return option logprobs");
	return { probs: softmax(lps), tokens: r.usage?.prompt_tokens ?? 0 };
}

/**
 * Answer a systemone-style question map. Keep/remove (`u<i>`) questions are
 * asked first; only the explanation matching each decision is then asked.
 * Returns null on any failure so the caller fails open.
 */
export async function readoutAnswers(
	state: string,
	questions: Record<string, Question>,
	cfg: CuratorConfig,
	outer: AbortSignal | undefined,
): Promise<Answers | null> {
	const signal = AbortSignal.any([AbortSignal.timeout(LOCAL_TIMEOUT_MS), ...(outer ? [outer] : [])]);
	const out: Answers = { answers: {}, usage: { input_tokens: 0 } };
	const ask = async (key: string) => {
		const q = questions[key];
		const ids = Object.keys(q.criteria);
		const { probs, tokens } = await readout(cfg, state, q.instructions, Object.values(q.criteria), signal);
		out.usage.input_tokens += tokens;
		if (q.type === "noul") out.answers[key] = { type: "noul", noul: probs[ids.indexOf("true")] };
		else out.answers[key] = { type: "choice", choice: ids[probs.indexOf(Math.max(...probs))] };
		return out.answers[key];
	};
	try {
		for (const key of Object.keys(questions).filter((k) => questions[k].type === "noul")) {
			const p = (await ask(key)).noul as number;
			const why = `${p >= cfg.threshold ? "why_keep_" : "why_remove_"}${key.slice(1)}`;
			if (questions[why]) await ask(why);
		}
		return out;
	} catch {
		return null;
	}
}
