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
 * Jev rejects is omitted from the current model context; system and summary
 * messages are always preserved.
 *
 * Wiring only — the real work lives in the sibling modules:
 *   config.ts      configuration
 *   keystore.ts    API key resolution + persistence
 *   units.ts       message introspection + grouping into units
 *   checkpoint.ts  content-addressed record of judged units
 *   jev.ts         the Jev decision call
 *   stats.ts       session cost + removal tracking
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { applyProvider, checkLoopbackUrl, isSemifMode, loadConfig, TAG } from "./config.ts";
import { clearTokenCache } from "./readout.ts";
import {
	confirmText,
	describe,
	findModel,
	freeLoopbackUrl,
	hasLlamaServer,
	managedServerUrl,
	inspectServer,
	isInstalled,
	LLAMA_INSTALL,
	MODELS,
	ramGb,
	recommend,
	SemifServer,
	type SemifModel,
} from "./semif.ts";
import {
	clearPersistedKey,
	loadLocalBaseUrl,
	loadPersistedModel,
	maskKey,
	persistKey,
	persistLocalBaseUrl,
	persistMode,
	persistModel,
	persistUserSettings,
	resolveApiKey,
} from "./keystore.ts";
import {
	createRemovalStats,
	createStats,
	formatStatsSummary,
	formatTokens,
	formatUsd,
	LOCAL_COST_NOTE,
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
import { askJev } from "./jev.ts";
import { ContextInspectionStore } from "./context-inspection.ts";
import { ContextInspectionDialog } from "./context-inspection-dialog.ts";
import { collectCacheMetrics } from "./cache-graph.ts";

export default function curatorJev(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	const stats = createStats();
	const removal = createRemovalStats();
	const checkpoint = new JudgmentCheckpoint();
	const contextInspection = new ContextInspectionStore();

	// Durable session entries let users inspect Jev's decisions without sending
	// inspected content back to the model. The in-memory store powers the
	// command; appendEntry makes the same record survive session reloads.
	pi.registerEntryRenderer("jev-context-removed", (entry, { expanded }, theme) => {
		const data = entry.data as { label?: string; text?: string; messageCount?: number; tokens?: number; reason?: string } | undefined;
		const label = data?.label ?? "context unit";
		const text = data?.text ?? "";
		const summary = `${label} — ${data?.messageCount ?? 0} message(s), ~${formatTokens(data?.tokens ?? 0)} tokens`;
		// Keep durable removal records available without making them compete with
		// the conversation. Expanded content remains inspectable on demand.
		const box = new Box(1, 0, (value) => value);
		box.addChild(new Text(theme.fg("dim", `[jev removed] ${summary}`), 0, 0));
		if (expanded) box.addChild(new Text(theme.fg("dim", text), 0, 0));
		return box;
	});
	// Kept decisions are durable inspection data but should not add visible
	// transcript entries; they remain available through the inspect popup.
	pi.registerEntryRenderer("jev-context-inspected", () => new Box(0, 0, (value) => value));

	// The latest snapshot is durable session data. It is deliberately separate
	// from the inspection entries so the stats command can be restored on
	// /resume without replaying or sending discarded context to the model.
	pi.registerEntryRenderer("jev-context-stats", (_entry, _options, _theme) => {
		// This is durable bookkeeping, not a user-facing event worth highlighting.
		return new Box(0, 0, (value) => value);
	});

	let enabled = process.env.CURATOR_JEV_ENABLED !== "0";
	let sessionApiKey: string | undefined;
	let warnedNoKey = false;
	let selfHosted = cfg.provider === "semif";
	const semif = new SemifServer();
	let activeSemifModel: SemifModel | undefined;
	let settingUp = false;
	let setupGeneration = 0;

	/**
	 * Make a SemIf server available at cfg.baseUrl, then flip to local mode.
	 * Order: already running -> use it; else pick model (recommended, user chooses) -> confirm -> download -> launch.
	 * `interactive` = user ran `mode semif` (may prompt/download); otherwise (startup) only start an already-downloaded model.
	 */
	const goLocal = async (ctx: ExtensionContext, interactive: boolean, modelArg?: string): Promise<void> => {
		const say = (m: string, lvl: "info" | "warning" | "error" = "info") => ctx.ui.notify(`[${TAG}] ${m}`, lvl);
		const activate = (m?: SemifModel, baseUrl?: string) => {
			clearTokenCache();
			applyProvider(cfg, "semif");
			if (baseUrl) {
				cfg.baseUrl = baseUrl;
				if (!process.env.SEMIF_BASE_URL) persistLocalBaseUrl(baseUrl);
			}
			selfHosted = true;
			activeSemifModel = m;
			warnedNoKey = false;
			persistMode("semif");
			if (m) persistModel(m.id);
		};
		if (settingUp) return say("SemIf setup already in progress", "warning");
		const generation = ++setupGeneration;
		const requestedModel = findModel(modelArg);
		if (modelArg && !requestedModel) return say(`unknown model "${modelArg}" — choose one of: ${MODELS.map((m) => m.id).join(", ")}`, "warning");
		let url = (process.env.SEMIF_BASE_URL || loadLocalBaseUrl() || "http://127.0.0.1:3000").replace(/\/+$/, "");
		const rejected = checkLoopbackUrl(url);
		if (rejected) return say(`SEMIF_BASE_URL rejected: ${rejected}`, "error");
		url = managedServerUrl(url) ?? url;
		const existing = await inspectServer(url, interactive ? 5000 : 2000);
		if (generation !== setupGeneration) return;
		const runningModel = findModel(existing.modelId);
		if (existing.ready && runningModel) {
			if (requestedModel && requestedModel.id !== runningModel.id) {
				return say(`A ${runningModel.name} server is already running at ${url}, but you requested ${requestedModel.name}. Run mode typesafe first to stop it, then mode semif ${requestedModel.id}.`, "warning");
			}
			activate(runningModel, url);
			return say(`SemIf ready — using ${runningModel.name} at ${url}`);
		}
		if (existing.listening && existing.modelId && runningModel && !existing.ready) {
			return say(`${runningModel.name} server is still loading at ${url}; wait, then rerun mode semif.`, "warning");
		}
		if (existing.listening) {
			if (process.env.SEMIF_BASE_URL) {
				return say(`SEMIF_BASE_URL is occupied by an unknown or unsupported server at ${url}; stop it or set SEMIF_BASE_URL to a free loopback port. No context was sent.`, "error");
			}
			const occupiedUrl = url;
			url = await freeLoopbackUrl();
			if (generation !== setupGeneration) return;
			say(`Port at ${occupiedUrl} belongs to another service; using free loopback port ${url}.`);
		}
		const launchUrl = managedServerUrl(url);
		if (!launchUrl) return say(`SemIf can launch only on a plain HTTP loopback origin (for example http://127.0.0.1:3000); ${url} is not supported for managed startup.`, "warning");
		url = launchUrl;
		if (!hasLlamaServer()) {
			return say(`no server at ${url} and llama-server is not installed. Install: ${LLAMA_INSTALL}, then run \`mode semif\`. Staying on current mode.`, "warning");
		}
		const rec = recommend();
		let model = requestedModel ?? findModel(loadPersistedModel());
		if (interactive && !requestedModel) {
			if (!ctx.hasUI) return say(`pass a model: mode semif ${MODELS.map((m) => m.id).join("|")} (recommended: ${rec.id})`, "warning");
			const labels = MODELS.map((m) => describe(m, rec, ramGb()));
			const picked = await ctx.ui.select(`Pick a SemIf model (this machine: ${ramGb()} GB RAM)`, labels);
			if (generation !== setupGeneration) return;
			if (!picked) return say("cancelled — staying on current mode");
			model = MODELS[labels.indexOf(picked)];
		}
		if (!model || (!interactive && !isInstalled(model))) {
			return say("SemIf mode is saved but no model is installed — run /jev-context-curator mode semif", "warning");
		}
		if (interactive && !isInstalled(model)) {
			const confirmed = await ctx.ui.confirm("Download and start SemIf?", confirmText(model, url));
			if (generation !== setupGeneration) return;
			if (!confirmed) return say("cancelled — staying on current mode");
		}
		const chosen = model;
		settingUp = true;
		say(isInstalled(chosen) ? `starting ${chosen.name}…` : `downloading ${chosen.name} in the background; curation switches over when ready`);
		void semif
			.start(chosen, url, (m) => ctx.ui.setStatus("semif", m), process.env.SEMIF_BASE_URL ? undefined : async () => {
				const occupiedUrl = url;
				url = await freeLoopbackUrl();
				say(`Port at ${occupiedUrl} was claimed during startup; retrying at ${url}.`);
				return url;
			})
			.then((err) => {
				if (generation !== setupGeneration) return;
				if (err) return say(`SemIf failed: ${err}. Staying on current mode.`, "error");
				activate(chosen, url);
				say(`SemIf ready — mode semif active (${chosen.name}) at ${url}`);
			})
			.finally(() => {
				if (generation !== setupGeneration) return;
				settingUp = false;
				ctx.ui.setStatus("semif", undefined);
			});
	};
	let contextCalls = 0;

	const debug = (ctx: ExtensionContext, msg: string) => {
		if (cfg.debug) ctx.ui.notify(`[${TAG}] ${msg}`, "info");
	};

	// Judgments are per-session: a new session starts with a clean checkpoint.
	pi.on("session_start", async (_event, ctx) => {
		// Saved mode is semif (env var or `mode semif` earlier): bring the server up without prompting.
		if (selfHosted) void goLocal(ctx, false);
		checkpoint.clear();
		contextInspection.clear();
		// Rehydrate the session-local removal list from durable TUI-only entries.
		// This is intentionally read from the active session, so /resume restores
		// its own history without leaking removals between sessions.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || !["jev-context-removed", "jev-context-inspected"].includes(entry.customType)) continue;
			const data = entry.data as {
				fingerprint?: string;
				label?: string;
				text?: string;
				reason?: string;
				messageCount?: number;
				tokens?: number;
				timestamp?: number;
				kept?: boolean;
			} | undefined;
			if (!data?.fingerprint || typeof data.text !== "string") continue;
			contextInspection.restore({
				fingerprint: data.fingerprint,
				label: data.label ?? "context unit",
				text: data.text,
				reason: data.reason,
				messageCount: data.messageCount ?? 0,
				tokens: data.tokens ?? 0,
				timestamp: data.timestamp ?? Date.now(),
				kept: data.kept ?? entry.customType === "jev-context-inspected",
			});
		}
		const fresh = createRemovalStats();
		Object.assign(removal, fresh);
		const freshCost = createStats();
		Object.assign(stats, freshCost);
		contextCalls = 0;
		// Restore the most recent aggregate snapshot for this session. Entries
		// are append-only, so the last matching one is the current state.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "jev-context-stats") continue;
			const data = entry.data as {
				stats?: Partial<typeof stats>;
				removal?: Partial<typeof removal>;
				contextCalls?: number;
			} | undefined;
			if (data?.stats) Object.assign(stats, data.stats);
			if (data?.removal) Object.assign(removal, data.removal);
			if (typeof data?.contextCalls === "number") contextCalls = data.contextCalls;
		}
		warnedNoKey = false;
	});

	const persistStats = () => {
		pi.appendEntry("jev-context-stats", {
			stats: { ...stats },
			removal: { ...removal },
			contextCalls,
			timestamp: Date.now(),
		});
	};

	const statusText = (): string => {
		const { key, source } = resolveApiKey(sessionApiKey);
		const untilNextCheck = cfg.frequency - (contextCalls % cfg.frequency);
		return [
			`┌─ ${TAG} ─────────────────────────────`,
			`│ ${enabled ? "● enabled" : "○ disabled"}   model: ${selfHosted ? (activeSemifModel?.name ?? "unknown (external server)") : cfg.model}`,
			`│ threshold: ${cfg.threshold}   min tokens: ${cfg.minTokens.toLocaleString()}`,
			`│ Jev frequency: every ${cfg.frequency} context call(s)`,
			`│ provider: ${selfHosted ? "semif (local)" : "typesafe (hosted)"}   endpoint: ${cfg.baseUrl}`,
			`│ switch mode: /jev-context-curator mode semif|typesafe`,
			selfHosted
				? `│ auth: ${cfg.endpointError ? `ENDPOINT REJECTED — ${cfg.endpointError} (context passes through)` : "none (loopback only; no API key is sent)"}`
				: `│ API key: ${key ? `${maskKey(key)} (${source})` : "MISSING"}`,
			`│ judged: ${checkpoint.judgedCount} units   context calls: ${contextCalls}`,
			`│ Jev calls: ${stats.calls}   next check: in ${untilNextCheck} context call(s)`,
			`│ cumulative removed: ${removal.sessionSavedMessages} messages (~${formatTokens(removal.sessionSavedTokens)} tokens)`,
			`│ session cost: ${selfHosted ? LOCAL_COST_NOTE : formatUsd(stats.costUsd)}`,
			"└────────────────────────────────────",
		].join("\n");
	};

	pi.registerCommand("jev-context-curator", {
		description: "Manage curation; switch provider mode with `mode semif|typesafe`",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ value: "status", description: "Show current curation status" },
				{ value: "stats", description: "Show session statistics" },
				{ value: "inspect", description: "Inspect kept and removed context decisions" },
				{ value: "mode", description: "Switch mode: semif (local) or typesafe (hosted); try `mode semif`" },
				{ value: "on", description: "Enable curation" },
				{ value: "off", description: "Disable curation" },
				{ value: "set-key", description: "Set the TypeSafe API key" },
				{ value: "clear-key", description: "Clear the stored API key" },
				{ value: "cost", description: "Show session cost" },
				{ value: "reset", description: "Reset the judgment checkpoint" },
				{ value: "threshold", description: "Set and save the keep threshold" },
				{ value: "min-tokens", description: "Set and save the context token floor" },
				{ value: "frequency", description: "Set and save query frequency" },
			];
			const filtered = subcommands.filter((command) => command.value.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((command) => ({ ...command, label: command.value })) : null;
		},
		handler: async (args, ctx) => {
			const [subRaw, ...rest] = args.trim().split(/\s+/);
			const sub = (subRaw || "status").toLowerCase();
			const val = rest.join(" ").trim();

			switch (sub) {
				case "mode": {
					const want = val.toLowerCase();
					if (!want) {
						ctx.ui.notify(
							`[${TAG}] mode: ${selfHosted ? "semif (local)" : "typesafe (hosted)"} — switch with /jev-context-curator mode typesafe|semif`,
							"info",
						);
					} else if (want === "typesafe") {
						setupGeneration++;
						settingUp = false;
						ctx.ui.setStatus("semif", undefined);
						semif.stop();
						applyProvider(cfg, "typesafe");
						selfHosted = false;
						activeSemifModel = undefined;
						warnedNoKey = false;
						persistMode("typesafe");
						ctx.ui.notify(`[${TAG}] mode typesafe — hosted Jev (local server stopped if pi started it)`, "info");
					} else if (isSemifMode(want.split(/\s+/)[0])) {
						await goLocal(ctx, true, want.split(/\s+/)[1]);
					} else {
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator mode typesafe|semif`, "warning");
					}
					break;
				}
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
						`[${TAG}] this session: ${stats.calls} Jev calls, ` +
							`${stats.inputTokens.toLocaleString()} input tokens, ` +
							(selfHosted
								? `cost ${LOCAL_COST_NOTE} (last call: ${stats.lastCallTokens.toLocaleString()} tokens)`
								: `estimated cost ${formatUsd(stats.costUsd)} ` +
									`(last call: ${formatUsd(stats.lastCallCostUsd)} over ${stats.lastCallTokens.toLocaleString()} tokens)`),
						"info",
					);
					break;
				case "stats":
					ctx.ui.notify(formatStatsSummary(stats, removal, selfHosted), "info");
					break;
				case "inspect":
				case "removed": {
					const entries = contextInspection.all;
					if (entries.length === 0) {
						ctx.ui.notify(`[${TAG}] no context decisions have been recorded in this session`, "info");
						break;
					}
					await ctx.ui.custom(
						(tui, theme, _keybindings, done) =>
							new ContextInspectionDialog(theme, entries, collectCacheMetrics(ctx.sessionManager.getEntries()), () => done(null)),
						{
							overlay: true,
							overlayOptions: {
								width: "90%",
								maxHeight: "85%",
								anchor: "center",
								margin: 1,
							},
						},
					);
					break;
				}
				case "reset": {
					checkpoint.clear();
					contextInspection.clear();
					const fresh = createRemovalStats();
					Object.assign(removal, fresh);
					persistStats();
					ctx.ui.notify(
						`[${TAG}] context inspection history cleared — all units will be re-judged from scratch (cost stats untouched)`,
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
					persistUserSettings({ threshold: n });
					ctx.ui.notify(`[${TAG}] keep threshold saved as ${n}`, "info");
					break;
				}
				case "min-tokens": {
					const n = Number.parseInt(val, 10);
					if (!Number.isFinite(n) || n < 0) {
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator min-tokens <n>`, "warning");
						break;
					}
					cfg.minTokens = n;
					persistUserSettings({ minTokens: n });
					ctx.ui.notify(`[${TAG}] minimum tokens saved as ${n}`, "info");
					break;
				}
				case "frequency": {
					const n = Number.parseInt(val, 10);
					if (!Number.isFinite(n) || n < 1) {
						ctx.ui.notify(`[${TAG}] usage: /jev-context-curator frequency <n>`, "warning");
						break;
					}
					cfg.frequency = n;
					persistUserSettings({ frequency: n });
					ctx.ui.notify(`[${TAG}] query frequency saved as every ${n} context calls`, "info");
					break;
				}
				default:
					ctx.ui.notify(statusText(), "info");
			}
		},
	});

	pi.on("session_shutdown", async () => {
		setupGeneration++;
		settingUp = false;
		semif.stop();
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		contextCalls++;
		// Local mode never resolves, reads, or sends a TypeSafe key.
		const apiKey = selfHosted ? undefined : resolveApiKey(sessionApiKey).key;
		if (selfHosted ? cfg.endpointError : !apiKey) {
			if (!warnedNoKey) {
				warnedNoKey = true;
				ctx.ui.notify(
					selfHosted
						? `[${TAG}] SEMIF_BASE_URL rejected: ${cfg.endpointError} — context passes through uncurated.`
						: `[${TAG}] No TypeSafe API key — context passes through uncurated. Run /jev-context-curator set-key <key> or set TYPESAFE_API_KEY.`,
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

		// The latest unit is the current request: never judge or drop it now.
		// It becomes eligible once newer messages arrive.
		units[units.length - 1].alwaysKeep = true;

		// Classify against the checkpoint: reuse past judgments, collect
		// only the new units after the checkpoint for Jev.
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
				`judging ${newUnits.length} new units (${reused} reused from checkpoint) via ${cfg.provider}/${cfg.model}…`,
			);
			const decision = await askJev(
				newUnits.map((n) => n.unit),
				apiKey,
				cfg,
				ctx.signal,
			);
			if (!decision) {
				// Fail open: keep everything this turn, record nothing so the
				// new units are retried on the next event.
				debug(ctx, "Jev call failed — keeping all context (fail-open)");
				return;
			}
			const callCost = recordCall(stats, decision.inputTokens, !selfHosted);
			persistStats();

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
				const inspected = contextInspection.record({
					fingerprint: fingerprintUnit(unit),
					label: unit.label,
					text: unit.text,
					reason: decision.reasons.get(local),
					messageCount: unit.messageIndexes.length,
					tokens: estimateTokens(unit.text),
					kept: keep,
				});
				if (inspected) {
					pi.appendEntry(keep ? "jev-context-inspected" : "jev-context-removed", {
						fingerprint: inspected.fingerprint,
						label: inspected.label,
						text: inspected.text,
						reason: inspected.reason,
						messageCount: inspected.messageCount,
						tokens: inspected.tokens,
						timestamp: inspected.timestamp,
						kept: inspected.kept,
					});
				}
			}
			recordDiscarded(removal, discardedUnits, discardedMessages, discardedTokens);
			debug(
				ctx,
				`judged ${judgedNow} units: kept ${keptNow}, discarded ${discardedUnits} ` +
					(selfHosted ? "(self-hosted, no API billing)" : `(cost ${formatUsd(callCost)} this call, ${formatUsd(stats.costUsd)} this session)`),
			);
		} else if (newUnits.length > 0 && !queryDue) {
			debug(ctx, `skipping Jev query on context call ${contextCalls} (frequency 1/${cfg.frequency})`);
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
		persistStats();

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
