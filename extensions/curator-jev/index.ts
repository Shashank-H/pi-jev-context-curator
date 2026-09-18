/**
 * curator-jev — entry point.
 *
 * A pi extension that curates the context sent to the LLM before each call,
 * using TypeSafe AI's Jev model to decide which context the next response is
 * likely to need.
 *
 * Wiring only — the real work lives in the sibling modules:
 *   config.ts    env-based configuration
 *   keystore.ts  API key resolution + persistence
 *   units.ts     message introspection + grouping into units
 *   jev.ts       the Jev decision call
 *   stats.ts     session cost tracking
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, TAG } from "./config.ts";
import {
	clearPersistedKey,
	maskKey,
	persistKey,
	resolveApiKey,
} from "./keystore.ts";
import { createStats, formatUsd, recordCall } from "./stats.ts";
import { describeMessage, estimateTokens, groupIntoUnits } from "./units.ts";
import { askJev } from "./jev.ts";

export default function curatorJev(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	const stats = createStats();
	let enabled = process.env.CURATOR_JEV_ENABLED !== "0";
	let sessionApiKey: string | undefined;
	let warnedNoKey = false;

	const debug = (ctx: ExtensionContext, msg: string) => {
		if (cfg.debug) ctx.ui.notify(`[${TAG}] ${msg}`, "info");
	};

	const statusLine = (): string => {
		const { key, source } = resolveApiKey(sessionApiKey);
		return (
			`[${TAG}] ${enabled ? "enabled" : "disabled"} | model=${cfg.model} ` +
			`| threshold=${cfg.threshold} | min-tokens=${cfg.minTokens} ` +
			`| api-key=${key ? `${maskKey(key)} (${source})` : "MISSING"} | ` +
			`session cost=${formatUsd(stats.costUsd)} (${stats.calls} calls, ${stats.inputTokens.toLocaleString()} input tokens)`
		);
	};

	pi.registerCommand("curator-jev", {
		description:
			"Control the Jev context curator: status | on | off | set-key <key> | clear-key | cost | threshold <0-1> | min-tokens <n>",
		handler: async (args, ctx) => {
			const [subRaw, ...rest] = args.trim().split(/\s+/);
			const sub = (subRaw || "status").toLowerCase();
			const val = rest.join(" ").trim();

			switch (sub) {
				case "on":
					enabled = true;
					ctx.ui.notify(`[${TAG}] enabled`, "info");
					break;
				case "off":
					enabled = false;
					ctx.ui.notify(`[${TAG}] disabled — context passes through untouched`, "info");
					break;
				case "set-key": {
					if (!val) {
						ctx.ui.notify(`[${TAG}] usage: /curator-jev set-key <typesafe-api-key>`, "warning");
						break;
					}
					sessionApiKey = val;
					persistKey(val);
					ctx.ui.notify(
						`[${TAG}] API key saved (${maskKey(val)}). Active for this session and persisted to ~/.pi/curator-jev.json (plaintext, mode 0600 — same as pi's own models.json).`,
						"info",
					);
					break;
				}
				case "clear-key": {
					sessionApiKey = undefined;
					clearPersistedKey();
					ctx.ui.notify(`[${TAG}] API key cleared (session and ~/.pi/curator-jev.json)`, "info");
					break;
				}
				case "cost":
					ctx.ui.notify(
						`[${TAG}] this session: ${stats.calls} Jev calls, ` +
							`${stats.inputTokens.toLocaleString()} input tokens, ` +
							`estimated cost ${formatUsd(stats.costUsd)} ` +
							`(last call: ${formatUsd(stats.lastCallCostUsd)} over ${stats.lastCallTokens.toLocaleString()} tokens)`,
						"info",
					);
					break;
				case "threshold": {
					const n = Number.parseFloat(val);
					if (!Number.isFinite(n) || n < 0 || n > 1) {
						ctx.ui.notify(`[${TAG}] usage: /curator-jev threshold <0-1>`, "warning");
						break;
					}
					cfg.threshold = n;
					ctx.ui.notify(`[${TAG}] keep threshold set to ${n}`, "info");
					break;
				}
				case "min-tokens": {
					const n = Number.parseInt(val, 10);
					if (!Number.isFinite(n) || n < 0) {
						ctx.ui.notify(`[${TAG}] usage: /curator-jev min-tokens <n>`, "warning");
						break;
					}
					cfg.minTokens = n;
					ctx.ui.notify(`[${TAG}] min tokens set to ${n}`, "info");
					break;
				}
				default:
					ctx.ui.notify(statusLine(), "info");
			}
		},
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		const { key: apiKey } = resolveApiKey(sessionApiKey);
		if (!apiKey) {
			if (!warnedNoKey) {
				warnedNoKey = true;
				ctx.ui.notify(
					`[${TAG}] No TypeSafe API key — context passes through uncurated. Run /curator-jev set-key <key> or set TYPESAFE_API_KEY.`,
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
		const decision = await askJev(units, decidable, apiKey, cfg, ctx.signal);
		if (!decision) {
			debug(ctx, "Jev call failed — keeping all context (fail-open)");
			return;
		}

		const callCost = recordCall(stats, decision.inputTokens);

		const dropped = units.length - decision.keep.size;
		if (dropped <= 0) {
			debug(ctx, `kept all ${units.length} units (cost ${formatUsd(callCost)} this call)`);
			return;
		}

		const keptMessages = messages.filter((_, mi) =>
			units.some((u, ui) => decision.keep.has(ui) && u.messageIndexes.includes(mi)),
		);
		debug(
			ctx,
			`dropped ${dropped}/${units.length} units, kept ${keptMessages.length}/${messages.length} messages ` +
				`(cost ${formatUsd(callCost)} this call, ${formatUsd(stats.costUsd)} this session)`,
		);
		return { messages: keptMessages };
	});
}
