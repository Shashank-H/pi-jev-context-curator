/**
 * Judge factory — the extension point for decision backends.
 *
 * A Judge answers one question per context unit: will any future response
 * need it? Backends register here; the context handler only talks to the
 * Judge interface, never to a concrete backend.
 *
 *   import { createJudge } from "./judge.ts";
 *   const judge = createJudge(cfg.judge); // "jev" | "classifier"
 *   const decision = await judge.ask({ units, anchorText, apiKey }, cfg, signal);
 *
 * Add a backend by implementing Judge and registering it below.
 */

import type { CuratorConfig, JudgeBackend } from "./config.ts";
import type { Unit } from "./units.ts";
import { askJev, type JevDecision } from "./jev.ts";
import { askClassifier } from "./classifier.ts";

export interface JudgeRequest {
	/** New units to judge. */
	units: Unit[];
	/**
	 * Current request text (the latest, never-judged unit). Backends that
	 * judge units independently use it as context; others may ignore it.
	 */
	anchorText: string;
	/** Resolved TypeSafe API key. Only set when the backend needs one. */
	apiKey?: string;
}

export interface Judge {
	/** Human label for status/debug output, e.g. "jev (jev-latest)". */
	displayName(cfg: CuratorConfig): string;
	/** Whether ask() needs req.apiKey to be set. */
	needsApiKey(): boolean;
	/**
	 * Judge the units. Returns which were judged and which to keep, or null
	 * on any failure — the caller must fail open when this returns null.
	 */
	ask(
		req: JudgeRequest,
		cfg: CuratorConfig,
		signal: AbortSignal | undefined,
	): Promise<JevDecision | null>;
}

const jevJudge: Judge = {
	displayName: (cfg) => `jev (${cfg.model})`,
	needsApiKey: () => true,
	ask: (req, cfg, signal) => {
		if (!req.apiKey) throw new Error("Jev judge needs a TypeSafe API key");
		return askJev(req.units, req.apiKey, cfg, signal);
	},
};

const classifierJudge: Judge = {
	displayName: (cfg) => `classifier.dev (${cfg.classifierTier})`,
	needsApiKey: () => false,
	ask: (req, cfg, signal) => askClassifier(req.units, req.anchorText, cfg, signal),
};

const REGISTRY: Record<JudgeBackend, Judge> = {
	jev: jevJudge,
	classifier: classifierJudge,
};

/** Create the judge backend selected by configuration. */
export function createJudge(backend: JudgeBackend): Judge {
	const judge = REGISTRY[backend];
	if (!judge) throw new Error(`Unknown judge backend: ${String(backend)}`);
	return judge;
}
