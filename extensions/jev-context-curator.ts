/**
 * pi-jev-context-curator
 *
 * A pi extension that curates the context sent to the LLM before each call.
 *
 * How it works:
 *  1. pi fires the `context` event before every LLM call with the full
 *     message list (`AgentMessage[]`).
 *  2. This extension groups messages into "units" (an assistant tool-call
 *     message plus its tool results stays together as one atomic unit) and
 *     asks TypeSafe AI's Jev model — via a single `/v1/systemone` request
 *     with one yes/no ("noul") question per unit — whether each unit is
 *     likely to be needed for the model's next response.
 *  3. Units Jev scores below the keep threshold are dropped; everything
 *     else is passed through.
 *
 * Safety properties (fail-open by design):
 *  - No `TYPESAFE_API_KEY` -> context passes through untouched.
 *  - Any Jev API error/timeout -> context passes through untouched.
 *  - System messages are always kept (they define tools/prompt sections).
 *  - The latest unit (the current user request) is always kept.
 *  - Curation only runs above a token floor (default 8k) to avoid adding
 *    latency to small contexts.
 *
 * The Jev decision call goes straight over `fetch` (not through pi's model
 * registry), so it never re-triggers `context` handlers — no recursion.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_TOKENS = 8000;
/** Keep Jev's `state` comfortably under its 32k token cap. */
const MAX_STATE_TOKENS = 28000;
/** Evidence per unit sent to Jev (chars, ~4 chars/token). */
const MAX_UNIT_CHARS = 1500;
const JEV_TIMEOUT_MS = 15000;

interface CuratorConfig {
	apiKey: string | undefined;
	baseUrl: string;
	model: string;
	/** Keep a unit when Jev's "needed" probability >= threshold. */
	threshold: number;
	/** Only curate when estimated context tokens exceed this. */
	minTokens: number;
	debug: boolean;
}

function loadConfig(): CuratorConfig {
	const threshold = Number.parseFloat(process.env.JEV_CURATOR_THRESHOLD ?? "");
	const minTokens = Number.parseInt(process.env.JEV_CURATOR_MIN_TOKENS ?? "", 10);
	return {
		apiKey: process.env.TYPESAFE_API_KEY || undefined,
		baseUrl: (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
		model: process.env.JEV_MODEL || DEFAULT_MODEL,
		threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_THRESHOLD,
		minTokens: Number.isFinite(minTokens) ? minTokens : DEFAULT_MIN_TOKENS,
		debug: process.env.JEV_CURATOR_DEBUG === "1",
	};
}

// ---------------------------------------------------------------------------
// Message introspection
// ---------------------------------------------------------------------------

type Role = string | undefined;

function roleOf(m: AgentMessage): Role {
	return (m as { role?: string }).role;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (typeof b === "string") return b;
				if (b && typeof b === "object") {
					const block = b as { type?: string; text?: string; thinking?: string };
					if (block.type === "text" && typeof block.text === "string") return block.text;
					if (block.type === "thinking" && typeof block.thinking === "string")
						return `[thinking] ${block.thinking}`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function toolCallsOf(m: AgentMessage): { id: string; name: string }[] {
	const content = (m as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(b): b is { type: "toolCall"; id: string; name: string } =>
				!!b && typeof b === "object" && (b as { type?: string }).type === "toolCall",
		)
		.map((b) => ({ id: b.id, name: b.name }));
}

/** Short human-readable description of one message, used as Jev evidence. */
function describeMessage(m: AgentMessage): { label: string; text: string } {
	const role = roleOf(m) ?? "unknown";
	if (role === "system") {
		const msg = m as { content?: unknown; sections?: Record<string, string | null> };
		const sections = msg.sections
			? `\n[prompt sections: ${Object.keys(msg.sections).join(", ")}]`
			: "";
		return { label: "system", text: textOf(msg.content) + sections };
	}
	if (role === "user") {
		return { label: "user", text: textOf((m as { content?: unknown }).content) };
	}
	if (role === "assistant") {
		const calls = toolCallsOf(m);
		const callSummary = calls.length
			? `\n[tool calls: ${calls.map((c) => c.name).join(", ")}]`
			: "";
		return { label: "assistant", text: textOf((m as { content?: unknown }).content) + callSummary };
	}
	if (role === "toolResult") {
		const msg = m as { toolName?: string; isError?: boolean; content?: unknown };
		const prefix = `[tool result: ${msg.toolName ?? "unknown"}${msg.isError ? " (errored)" : ""}]`;
		return { label: `toolResult:${msg.toolName ?? "?"}`, text: `${prefix}\n${textOf(msg.content)}` };
	}
	return { label: role, text: textOf((m as { content?: unknown }).content) || JSON.stringify(m).slice(0, 500) };
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Units: an assistant tool-call + its tool results form one atomic unit
// ---------------------------------------------------------------------------

interface Unit {
	/** Indexes into the original message list. */
	messageIndexes: number[];
	label: string;
	text: string;
	/** Units that must never be dropped. */
	alwaysKeep: boolean;
}

function groupIntoUnits(messages: AgentMessage[]): Unit[] {
	const units: Unit[] = [];
	let pending: number[] | null = null;

	const flush = () => {
		if (pending && pending.length > 0) units.push(makeUnit(messages, pending));
		pending = null;
	};

	messages.forEach((m, i) => {
		const role = roleOf(m);
		if (pending) {
			if (role === "toolResult") {
				pending.push(i);
				return;
			}
			flush();
		}
		if (role === "assistant" && toolCallsOf(m).length > 0) {
			pending = [i];
			return;
		}
		units.push(makeUnit(messages, [i]));
	});
	flush();
	return units;
}

function makeUnit(messages: AgentMessage[], indexes: number[]): Unit {
	const described = indexes.map((i) => describeMessage(messages[i]));
	const label = described.map((d) => d.label).join("+");
	const text = described.map((d) => d.text).join("\n---\n");
	const hasSystem = indexes.some((i) => roleOf(messages[i]) === "system");
	return { messageIndexes: indexes, label, text, alwaysKeep: hasSystem };
}

// ---------------------------------------------------------------------------
// Jev decision call
// ---------------------------------------------------------------------------

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

function truncate(s: string, maxChars: number): string {
	return s.length > maxChars ? s.slice(0, maxChars) + "\n…[truncated]" : s;
}

/**
 * Ask Jev which units are likely needed for the next LLM response.
 * Returns the set of unit indexes to keep, or `null` on any failure
 * (caller must fail open and keep everything).
 */
async function askJev(
	units: Unit[],
	decidable: number[],
	cfg: CuratorConfig,
	signal: AbortSignal | undefined,
): Promise<Set<number> | null> {
	// Build the numbered transcript as Jev's `state`. Question keys are not
	// sent to the model, so each question's instructions name its unit number.
	const lines = units.map((u, i) => `[${i}] (${u.label})\n${truncate(u.text, MAX_UNIT_CHARS)}`);

	// Enforce Jev's state token budget: drop the *oldest* decidable units from
	// the decision set (they are kept, not dropped).
	let stateText = lines.join("\n\n");
	const kept = new Set<number>(units.map((_, i) => i).filter((i) => !decidable.includes(i)));
	let active = [...decidable];
	while (active.length > 0 && estimateTokens(stateText) > MAX_STATE_TOKENS) {
		const dropped = active.shift()!;
		kept.add(dropped);
		stateText = active.map((i) => lines[i]).join("\n\n");
	}
	if (active.length === 0) return kept;

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
				Authorization: `Bearer ${cfg.apiKey}`,
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
			if (typeof p === "number" && p >= cfg.threshold) kept.add(i);
			// Non-numeric/missing answer -> drop nothing: keep the unit.
			else if (typeof p !== "number") kept.add(i);
		}
		return kept;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function jevContextCurator(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	let enabled = process.env.JEV_CURATOR_ENABLED !== "0";
	let warnedNoKey = false;

	const debug = (ctx: ExtensionContext, msg: string) => {
		if (cfg.debug) ctx.ui.notify(`[jev-curator] ${msg}`, "info");
	};

	pi.registerCommand("jev-curator", {
		description: "Control the Jev context curator: on | off | status | threshold <0-1> | min-tokens <n>",
		handler: async (args, ctx) => {
			const [sub, val] = args.trim().split(/\s+/, 2);
			switch ((sub || "status").toLowerCase()) {
				case "on":
					enabled = true;
					ctx.ui.notify("[jev-curator] enabled", "info");
					break;
				case "off":
					enabled = false;
					ctx.ui.notify("[jev-curator] disabled — context passes through untouched", "info");
					break;
				case "threshold": {
					const n = Number.parseFloat(val ?? "");
					if (!Number.isFinite(n) || n < 0 || n > 1) {
						ctx.ui.notify("[jev-curator] usage: /jev-curator threshold <0-1>", "warning");
						break;
					}
					cfg.threshold = n;
					ctx.ui.notify(`[jev-curator] keep threshold set to ${n}`, "info");
					break;
				}
				case "min-tokens": {
					const n = Number.parseInt(val ?? "", 10);
					if (!Number.isFinite(n) || n < 0) {
						ctx.ui.notify("[jev-curator] usage: /jev-curator min-tokens <n>", "warning");
						break;
					}
					cfg.minTokens = n;
					ctx.ui.notify(`[jev-curator] min tokens set to ${n}`, "info");
					break;
				}
				default:
					ctx.ui.notify(
						`[jev-curator] ${enabled ? "enabled" : "disabled"} | model=${cfg.model} ` +
							`| threshold=${cfg.threshold} | min-tokens=${cfg.minTokens} ` +
							`| api-key=${cfg.apiKey ? "set" : "MISSING (set TYPESAFE_API_KEY)"}`,
						"info",
					);
			}
		},
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		if (!cfg.apiKey) {
			if (!warnedNoKey) {
				warnedNoKey = true;
				ctx.ui.notify(
					"[jev-curator] TYPESAFE_API_KEY is not set — context passes through uncurated.",
					"warning",
				);
			}
			return;
		}

		const messages = event.messages;
		if (messages.length <= 2) return;

		const usage = ctx.getContextUsage();
		const estTokens =
			usage?.tokens ?? messages.reduce((n, m) => n + estimateTokens(describeMessage(m).text), 0);
		if (estTokens < cfg.minTokens) return;

		const units = groupIntoUnits(messages);
		if (units.length <= 1) return;

		// Never drop the latest unit (the current user request).
		const lastIdx = units.length - 1;
		units[lastIdx].alwaysKeep = true;
		const decidable = units.map((_, i) => i).filter((i) => !units[i].alwaysKeep);
		if (decidable.length === 0) return;

		debug(ctx, `curating ${units.length} units (~${estTokens} tokens) via ${cfg.model}…`);
		const keep = await askJev(units, decidable, cfg, ctx.signal);
		if (!keep) {
			debug(ctx, "Jev call failed — keeping all context (fail-open)");
			return;
		}

		const dropped = units.length - keep.size;
		if (dropped <= 0) return;

		const keptMessages = messages.filter((_, mi) =>
			units.some((u, ui) => keep.has(ui) && u.messageIndexes.includes(mi)),
		);
		debug(ctx, `dropped ${dropped}/${units.length} units, kept ${keptMessages.length}/${messages.length} messages`);
		return { messages: keptMessages };
	});
}
