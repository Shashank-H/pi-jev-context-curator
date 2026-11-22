/** Shared constants and environment-based configuration for curator-jev. */

import { loadLocalBaseUrl, loadPersistedMode } from "./keystore.ts";

export const TAG = "jev-context-curator";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
/** Local SemIf: llama.cpp `llama-server` on loopback (see semif.ts / readout.ts). */
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:3000";
export const DEFAULT_LOCAL_MODEL = "openjev";
// Conservative default: preserve useful context unless Jev is fairly confident
// that it is clearly disposable.
export const DEFAULT_THRESHOLD = 0.4;
export const DEFAULT_MIN_TOKENS = 8000;
export const DEFAULT_FREQUENCY = 5;

/** Keep Jev's `state` comfortably under its 32k token cap. */
export const MAX_STATE_TOKENS = 28000;
/**
 * Local small models run `llama-server -c 8192`; every question is prefilled as
 * state + its own instructions, so keep `state` well below that (chars/4 is a
 * rough estimate; code tokenizes denser).
 */
export const LOCAL_MAX_STATE_TOKENS = 4000;
/** Evidence per unit sent to Jev (chars, ~4 chars/token). */
export const MAX_UNIT_CHARS = 1500;
export const JEV_TIMEOUT_MS = 15000;
/** Local models read one question at a time; allow a cold prefill. */
export const LOCAL_TIMEOUT_MS = 60000;

/** Jev pricing: $42 per billion input tokens; outputs are free. */
export const JEV_USD_PER_MTOK_INPUT = 0.042;

export type Provider = "typesafe" | "openjev-local";

export interface CuratorConfig {
	/** `typesafe` (hosted, API key required) or `openjev-local` (explicit loopback server, no key). */
	provider: Provider;
	baseUrl: string;
	/** Why the endpoint is unusable (local mode only); curation passes through while set. */
	endpointError?: string;
	/** Token budget for the `state` sent per request. */
	maxStateTokens: number;
	model: string;
	/** Keep a unit when Jev's "needed" probability >= threshold. */
	threshold: number;
	/** Only curate when estimated context tokens exceed this. */
	minTokens: number;
	/** Run a new Jev query on every Nth context/model call. */
	frequency: number;
	debug: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Validate a keyless endpoint: http(s) to an explicit loopback host, no embedded
 * credentials. Anything else is rejected so private context is never sent
 * unauthenticated to an arbitrary URL.
 */
export function checkLoopbackUrl(raw: string): string | undefined {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return `invalid URL "${raw}"`;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return `unsupported scheme ${u.protocol}`;
	if (u.username || u.password) return "URL must not contain credentials";
	if (!LOOPBACK_HOSTS.has(u.hostname)) {
		return `${u.hostname} is not loopback (127.0.0.1, localhost, [::1]); keyless mode is loopback-only`;
	}
	return undefined;
}

/** Mode names that select the self-hosted server (SemIf, formerly OpenJev). Anything else is hosted. */
export const isLocalMode = (v: string | undefined): boolean =>
	v !== undefined && ["semif", "openjev", "openjev-local"].includes(v.toLowerCase());

/** Switch an existing config between hosted and self-hosted (runtime `mode` command). */
export function applyProvider(cfg: CuratorConfig, provider: Provider): void {
	const local = provider === "openjev-local";
	cfg.provider = provider;
	cfg.baseUrl = (
		local ? process.env.OPENJEV_BASE_URL || loadLocalBaseUrl() || DEFAULT_LOCAL_BASE_URL : process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL
	).replace(/\/+$/, "");
	cfg.endpointError = local ? checkLoopbackUrl(cfg.baseUrl) : undefined;
	cfg.maxStateTokens = local ? LOCAL_MAX_STATE_TOKENS : MAX_STATE_TOKENS;
	cfg.model = process.env.JEV_MODEL || (local ? DEFAULT_LOCAL_MODEL : DEFAULT_MODEL);
}

export function loadConfig(): CuratorConfig {
	const threshold = Number.parseFloat(process.env.CURATOR_JEV_THRESHOLD ?? "");
	const minTokens = Number.parseInt(process.env.CURATOR_JEV_MIN_TOKENS ?? "", 10);
	const frequency = Number.parseInt(process.env.CURATOR_JEV_FREQUENCY ?? "", 10);
	const local = isLocalMode(process.env.CURATOR_JEV_PROVIDER ?? loadPersistedMode());
	const baseUrl = (
		local ? process.env.OPENJEV_BASE_URL || loadLocalBaseUrl() || DEFAULT_LOCAL_BASE_URL : process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL
	).replace(/\/+$/, "");
	return {
		provider: local ? "openjev-local" : "typesafe",
		baseUrl,
		endpointError: local ? checkLoopbackUrl(baseUrl) : undefined,
		maxStateTokens: local ? LOCAL_MAX_STATE_TOKENS : MAX_STATE_TOKENS,
		model: process.env.JEV_MODEL || (local ? DEFAULT_LOCAL_MODEL : DEFAULT_MODEL),
		threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_THRESHOLD,
		minTokens: Number.isFinite(minTokens) && minTokens > 0 ? minTokens : DEFAULT_MIN_TOKENS,
		frequency: Number.isFinite(frequency) && frequency > 0 ? frequency : DEFAULT_FREQUENCY,
		debug: process.env.CURATOR_JEV_DEBUG === "1",
	};
}
