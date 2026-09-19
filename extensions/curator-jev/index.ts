/**
 * curator-jev — entry point.
 *
 * A pi extension that curates the context sent to the LLM before each call,
 * using TypeSafe AI's Jev model to decide which context any future response
 * might need.
 *
 * Checkpoint model: every unit Jev judges is recorded by content fingerprint.
 * Each `context` event reuses past judgments and sends only new units (those
 * after the checkpoint) to Jev, so the same data is never sent twice. A unit
 * Jev rejects is permanently discarded from what the model sees.
 *
 * Wiring only — the real work lives in the sibling modules:
 *   config.ts      env-based configuration
 *   keystore.ts    API key resolution + persistence
 *   units.ts       message introspection + grouping into units
 *   checkpoint.ts  content-addressed record of judged units
 *   judge.ts       Judge factory (jev.ts / classifier.ts backends)
 *   stats.ts       session cost + removal tracking
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, parseClassifierTier, parseJudgeBackend, TAG, type JudgeBackend } from "./config.ts";
import {
	clearPersistedKey,
	loadPrefs,
	maskKey,
	persistKey,
	resolveApiKey,
	savePrefs,
} from "./keystore.ts";
import {
	createRemovalStats,
	createStats,
	formatStatsSummary,
	formatTokens,
	formatUsd,
	recordCall,
	recordCuration,
	recordDiscarded,
} from "./stats.ts";
import {
	describeMessage,
	estimateTokens,
	fingerprintUnit,
	groupIntoUnits,
	type Unit,
} from "./units.ts";
import { JudgmentCheckpoint } from "./checkpoint.ts";
import { createJudge } from "./judge.ts";

export default function curatorJev(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	// Persisted setup choice (from `setup`/`judge`) fills in what env vars
	// didn't say; env always wins. Until a backend is chosen at all, the
	// extension fails open — context passes through untouched.
	const stored = loadPrefs();
	const envJudge = parseJudgeBackend(process.env.CURATOR_JEV_JUDGE);
	if (envJudge) cfg.judge = envJudge;
	else if (stored.judge) cfg.judge = stored.judge;
	const envTier = parseClassifierTier(process.env.CURATOR_JEV_CLASSIFIER_TIER);
	if (envTier) cfg.classifierTier = envTier;
	else if (stored.classifierTier) cfg.classifierTier = stored.classifierTier;
	let setupDone = envJudge !== undefined || stored.judge !== undefined;
	let warnedSetup = false;
	const stats = createStats();
	const removal = createRemovalStats();
	const checkpoint = new JudgmentCheckpoint();
	let enabled = process.env.CURATOR_JEV_ENABLED !== "0";
	let sessionApiKey: string | undefined;
	let warnedNoKey = false;
	let contextCalls = 0;

	const debug = (ctx: ExtensionContext, msg: string) => {
		if (cfg.debug) ctx.ui.notify(`[${TAG}] ${msg}`, "info");
	};

	// Judgments are per-session: a new session starts with a clean checkpoint.
	pi.on("session_start", () => {
		checkpoint.clear();
		const fresh = createRemovalStats();
		Object.assign(removal, fresh);
		const freshCost = createStats();
		Object.assign(stats, freshCost);
		warnedNoKey = false;
		warnedSetup = false;
		contextCalls = 0;
	});

	const statusText = (): string => {
		const { key, source } = resolveApiKey(sessionApiKey);
		const untilNextCheck = cfg.frequency - (contextCalls % cfg.frequency);
		const judgeLine =
			cfg.judge === "classifier"
				? `classifier.dev (${cfg.classifierTier} tier, keyless)`
				: `jev (${cfg.model})`;
		const keyLine =
			cfg.judge === "classifier" ? "n/a — keyless" : key ? `${maskKey(key)} (${source})` : "MISSING";
		return [
			`┌─ ${TAG} ─────────────────────────────`,
			`│ ${enabled ? "● enabled" : "○ disabled"}   judge: ${judgeLine}`,
			`│ setup: ${setupDone ? "complete" : "pending — run /jev-context-curator setup"}`,
			`│ threshold: ${cfg.threshold}   min tokens: ${cfg.minTokens.toLocaleString()}`,
			`│ judge frequency: every ${cfg.frequency} context call(s)`,
			`│ API key: ${keyLine}`,
			`│ judged: ${checkpoint.judgedCount} units   context calls: ${contextCalls}`,
			`│ judge calls: ${stats.calls}   next check: in ${untilNextCheck} context call(s)`,
			`│ cumulative removed: ${removal.sessionSavedMessages} messages (~${formatTokens(removal.sessionSavedTokens)} tokens)`,
			`│ session cost: ${formatUsd(stats.costUsd)}`,
			"└────────────────────────────────────",
		].join("\n");
	};

	const backendName = (): string => (cfg.judge === "classifier" ? "classifier.dev" : "Jev");

	pi.registerCommand("jev-context-curator", {
		description:
			"Control the context pruner: setup | status | stats | on | off | set-key <key> | clear-key | cost | reset | threshold <0-1> | min-tokens <n> | frequency <n> | judge <jev|classifier>",
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
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator set-key <typesafe-api-key>`, "warning");
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
						`[${TAG}] this session: ${stats.calls} ${backendName()} calls, ` +
							`${stats.inputTokens.toLocaleString()} input tokens, ` +
							`estimated cost ${formatUsd(stats.costUsd)} ` +
							`(last call: ${formatUsd(stats.lastCallCostUsd)} over ${stats.lastCallTokens.toLocaleString()} tokens)`,
						"info",
					);
					break;
				case "stats":
					ctx.ui.notify(formatStatsSummary(stats, removal, backendName()), "info");
					break;
				case "reset": {
					checkpoint.clear();
					const fresh = createRemovalStats();
					Object.assign(removal, fresh);
					ctx.ui.notify(
						`[${TAG}] checkpoint cleared — all units will be re-judged from scratch (cost stats untouched)`,
						"info",
					);
					break;
				}
				case "threshold": {
					const n = Number.parseFloat(val);
					if (!Number.isFinite(n) || n < 0 || n > 1) {
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator threshold <0-1>`, "warning");
						break;
					}
					cfg.threshold = n;
					ctx.ui.notify(`[${TAG}] keep threshold set to ${n}`, "info");
					break;
				}
				case "min-tokens": {
					const n = Number.parseInt(val, 10);
					if (!Number.isFinite(n) || n < 0) {
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator min-tokens <n>`, "warning");
						break;
					}
					cfg.minTokens = n;
					ctx.ui.notify(`[${TAG}] min tokens set to ${n}`, "info");
					break;
				}
				case "frequency": {
					const n = Number.parseInt(val, 10);
					if (!Number.isFinite(n) || n < 1) {
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator frequency <n>`, "warning");
						break;
					}
					cfg.frequency = n;
					ctx.ui.notify(`[${TAG}] judge queries now run every ${n} context calls`, "info");
					break;
				}
				case "judge": {
					const v = val.toLowerCase();
					if (v !== "jev" && v !== "classifier") {
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator judge <jev|classifier>`, "warning");
						break;
					}
					cfg.judge = v;
					savePrefs({ judge: v });
					setupDone = true;
					ctx.ui.notify(
						v === "classifier"
							? `[${TAG}] judge set to classifier.dev (keyless, free) — no API key needed`
							: `[${TAG}] judge set to Jev (TypeSafe API) — needs an API key`,
						"info",
					);
					break;
				}
				case "setup": {
					const pick = await ctx.ui.select(
						"Which judge should curate your context?",
						[
							"classifier.dev — keyless, free",
							"Jev via TypeSafe API — needs an API key",
						],
						{ timeout: 60_000 },
					);
					if (!pick) {
						ctx.ui.notify(`[${TAG}] setup cancelled`, "info");
						break;
					}
					const backend: JudgeBackend = pick.startsWith("classifier") ? "classifier" : "jev";
					if (backend === "jev") {
						const key = await ctx.ui.input("TypeSafe API key", "paste your key from console.typesafe.ai", {
							timeout: 120_000,
						});
						if (!key?.trim()) {
							ctx.ui.notify(
								`[${TAG}] setup cancelled — the Jev backend needs an API key`,
								"warning",
							);
							break;
						}
						sessionApiKey = key.trim();
						persistKey(sessionApiKey);
					}
					cfg.judge = backend;
					savePrefs({ judge: backend });
					setupDone = true;
					ctx.ui.notify(
						backend === "classifier"
							? `[${TAG}] setup complete — judge: classifier.dev (fast tier, keyless, free). Context will be curated from now on.`
							: `[${TAG}] setup complete — judge: Jev (TypeSafe API). Key saved (${maskKey(sessionApiKey as string)}) to ~/.pi/curator-jev.json. Context will be curated from now on.`,
						"info",
					);
					break;
				}
				default:
					ctx.ui.notify(statusText(), "info");
			}
		},
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		contextCalls++;
		if (!setupDone) {
			// Fail open until the user picks a judge: never touch context silently.
			if (!warnedSetup) {
				warnedSetup = true;
				ctx.ui.notify(
					`[${TAG}] not set up yet — context passes through uncurated. Run /jev-context-curator setup to pick a judge backend.`,
					"info",
				);
			}
			return;
		}
		const judge = createJudge(cfg.judge);
		let apiKey: string | undefined;
		if (judge.needsApiKey()) {
			const resolved = resolveApiKey(sessionApiKey);
			apiKey = resolved.key;
			if (!apiKey) {
				if (!warnedNoKey) {
					warnedNoKey = true;
					ctx.ui.notify(
						`[${TAG}] No TypeSafe API key — context passes through uncurated. Run /jev-context-curator setup, /jev-context-curator set-key <key>, or set TYPESAFE_API_KEY.`,
						"warning",
					);
				}
				return;
			}
		}

		const messages = event.messages;
		if (messages.length <= 2) return;

		const usage = ctx.getContextUsage();
		const estTokens =
			usage?.tokens ?? messages.reduce((n, m) => n + estimateTokens(describeMessage(m).text), 0);
		if (estTokens < cfg.minTokens) return;

		const units = groupIntoUnits(messages);
		if (units.length <= 1) return;

		// The latest unit is the current request: never judge or drop it now.
		// It becomes eligible once newer messages arrive.
		units[units.length - 1].alwaysKeep = true;

		// Classify against the checkpoint: reuse past judgments, collect
		// only the new units after the checkpoint for the judge.
		const keepUnit = new Array<boolean>(units.length).fill(true);
		const newUnits: { unit: Unit; index: number }[] = [];
		let reused = 0;
		for (let i = 0; i < units.length; i++) {
			const u = units[i];
			if (u.alwaysKeep) continue;
			const prior = checkpoint.get(fingerprintUnit(u));
			if (prior !== undefined) {
				keepUnit[i] = prior;
				reused++;
			} else {
				newUnits.push({ unit: u, index: i });
			}
		}

		let judgedNow = 0;
		let keptNow = 0;
		const queryDue = contextCalls % cfg.frequency === 0;
		if (newUnits.length > 0 && queryDue) {
			debug(
				ctx,
				`judging ${newUnits.length} new units (${reused} reused from checkpoint) via ${judge.displayName(cfg)}…`,
			);
			const decision = await judge.ask(
				{
					units: newUnits.map((n) => n.unit),
					anchorText: units[units.length - 1].text,
					apiKey,
				},
				cfg,
				ctx.signal,
			);
			if (!decision) {
				// Fail open: keep everything this turn, record nothing so the
				// new units are retried on the next event.
				debug(ctx, `${backendName()} call failed — keeping all context (fail-open)`);
				return;
			}
			const callCost = recordCall(stats, decision.inputTokens);

			let discardedUnits = 0;
			let discardedMessages = 0;
			let discardedTokens = 0;
			for (const local of decision.judged) {
				const { unit, index } = newUnits[local];
				const keep = decision.keep.has(local);
				checkpoint.record(fingerprintUnit(unit), keep);
				keepUnit[index] = keep;
				judgedNow++;
				if (keep) {
					keptNow++;
				} else {
					discardedUnits++;
					discardedMessages += unit.messageIndexes.length;
					discardedTokens += estimateTokens(unit.text);
				}
			}
			recordDiscarded(removal, discardedUnits, discardedMessages, discardedTokens);
			debug(
				ctx,
				`judged ${judgedNow} units: kept ${keptNow}, discarded ${discardedUnits} ` +
					`(cost ${formatUsd(callCost)} this call, ${formatUsd(stats.costUsd)} this session)`,
			);
		} else if (newUnits.length > 0 && !queryDue) {
			debug(ctx, `skipping judge query on context call ${contextCalls} (frequency 1/${cfg.frequency})`);
		}

		// Apply removals: drop every message belonging to a discarded unit.
		const keptIdx = new Set<number>();
		let removedMessages = 0;
		let removedTokens = 0;
		units.forEach((u, ui) => {
			if (keepUnit[ui]) {
				u.messageIndexes.forEach((mi) => keptIdx.add(mi));
			} else {
				removedMessages += u.messageIndexes.length;
				removedTokens += estimateTokens(u.text);
			}
		});
		recordCuration(removal, judgedNow, messages.length, estTokens, removedMessages, removedTokens);

		if (removedMessages === 0) {
			debug(ctx, `no removals: ${messages.length} messages (~${formatTokens(estTokens)} tokens) all kept`);
			return;
		}

		const keptMessages = messages.filter((_, mi) => keptIdx.has(mi));
		debug(
			ctx,
			`context: ${messages.length} messages (~${formatTokens(estTokens)} tokens) -> ` +
				`removed ${removedMessages} (~${formatTokens(removedTokens)}), ` +
				`kept ${keptMessages.length} | discarded total this session: ${removal.messagesRemoved} msgs (~${formatTokens(removal.tokensRemoved)} tokens)`,
		);
		ctx.ui.notify(
			`[${TAG}] curated context — cumulative removed: ${formatTokens(removal.sessionSavedTokens)} tokens (${removal.sessionSavedMessages} messages)`,
			"info",
		);
		return { messages: keptMessages };
	});
}
