/** Shared constants and environment-based configuration for curator-jev. */

export const TAG = "curator-jev";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_MIN_TOKENS = 8000;

/** Keep Jev's `state` comfortably under its 32k token cap. */
export const MAX_STATE_TOKENS = 28000;
/** Evidence per unit sent to Jev (chars, ~4 chars/token). */
export const MAX_UNIT_CHARS = 1500;
export const JEV_TIMEOUT_MS = 15000;

/** Jev pricing: $42 per billion input tokens; outputs are free. */
export const JEV_USD_PER_MTOK_INPUT = 0.042;

export interface CuratorConfig {
	baseUrl: string;
	model: string;
	/** Keep a unit when Jev's "needed" probability >= threshold. */
	threshold: number;
	/** Only curate when estimated context tokens exceed this. */
	minTokens: number;
	debug: boolean;
}

export function loadConfig(): CuratorConfig {
	const threshold = Number.parseFloat(process.env.CURATOR_JEV_THRESHOLD ?? "");
	const minTokens = Number.parseInt(process.env.CURATOR_JEV_MIN_TOKENS ?? "", 10);
	return {
		baseUrl: (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
		model: process.env.JEV_MODEL || DEFAULT_MODEL,
		threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_THRESHOLD,
		minTokens: Number.isFinite(minTokens) ? minTokens : DEFAULT_MIN_TOKENS,
		debug: process.env.CURATOR_JEV_DEBUG === "1",
	};
}
