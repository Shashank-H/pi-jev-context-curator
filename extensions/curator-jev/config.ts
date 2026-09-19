/** Shared constants and environment-based configuration for curator-jev. */

export const TAG = "jev-context-curator";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_MIN_TOKENS = 8000;
export const DEFAULT_FREQUENCY = 5;

/** Keep Jev's `state` comfortably under its 32k token cap. */
export const MAX_STATE_TOKENS = 28000;
/** Evidence per unit sent to Jev (chars, ~4 chars/token). */
export const MAX_UNIT_CHARS = 1500;
export const JEV_TIMEOUT_MS = 15000;

/** Jev pricing: $42 per billion input tokens; outputs are free. */
export const JEV_USD_PER_MTOK_INPUT = 0.042;

/** Keyless zero-shot classification API (itself powered by Jev). */
export const CLASSIFIER_URL = "https://classifier.dev";
export const CLASSIFIER_TIMEOUT_MS = 15000;

/**
 * Which backend judges units: "jev" (TypeSafe API, needs a key) or
 * "classifier" (classifier.dev, keyless).
 */
export type JudgeBackend = "jev" | "classifier";
/**
 * classifier.dev tier: "fast" (Jev, one round trip) or "smart" (re-asks
 * uncertain units with a reasoning model).
 */
export type ClassifierTier = "fast" | "smart";

export interface CuratorConfig {
	baseUrl: string;
	model: string;
	/** Keep a unit when Jev's "needed" probability >= threshold. */
	threshold: number;
	/** Only curate when estimated context tokens exceed this. */
	minTokens: number;
	/** Run a new Jev query on every Nth context/model call. */
	frequency: number;
	debug: boolean;
	judge: JudgeBackend;
	classifierTier: ClassifierTier;
}

export function loadConfig(): CuratorConfig {
	const threshold = Number.parseFloat(process.env.CURATOR_JEV_THRESHOLD ?? "");
	const minTokens = Number.parseInt(process.env.CURATOR_JEV_MIN_TOKENS ?? "", 10);
	const frequency = Number.parseInt(process.env.CURATOR_JEV_FREQUENCY ?? "", 10);
	const judge: JudgeBackend =
		(process.env.CURATOR_JEV_JUDGE ?? "").toLowerCase() === "classifier" ? "classifier" : "jev";
	const classifierTier: ClassifierTier =
		(process.env.CURATOR_JEV_CLASSIFIER_TIER ?? "").toLowerCase() === "smart" ? "smart" : "fast";
	return {
		baseUrl: (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
		model: process.env.JEV_MODEL || DEFAULT_MODEL,
		threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_THRESHOLD,
		minTokens: Number.isFinite(minTokens) && minTokens > 0 ? minTokens : DEFAULT_MIN_TOKENS,
		frequency: Number.isFinite(frequency) && frequency > 0 ? frequency : DEFAULT_FREQUENCY,
		debug: process.env.CURATOR_JEV_DEBUG === "1",
		judge,
		classifierTier,
	};
}
