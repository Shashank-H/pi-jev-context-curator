/**
 * API key management.
 *
 * Resolution order:
 *   1. key set via `/jev-context-curator set-key` (current session only, in memory)
 *   2. `TYPESAFE_API_KEY` environment variable
 *   3. key persisted in `~/.pi/curator-jev.json` by a previous `set-key`
 *
 * The persisted file is plaintext with mode 0600 — the same convention pi
 * itself uses for `~/.pi/agent/models.json`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_FILE = process.env.CURATOR_JEV_CONFIG || join(homedir(), ".pi", "curator-jev.json");

export interface ApiKeyResolution {
	key: string | undefined;
	source: string;
}

export interface UserSettings {
	threshold?: number;
	minTokens?: number;
	frequency?: number;
}

type Persisted = { apiKey?: string; mode?: string; model?: string; localBaseUrl?: string; settings?: UserSettings };

function readPersisted(): Persisted {
	try {
		if (!existsSync(CONFIG_FILE)) return {};
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Persisted;
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

/** Read-modify-write so the key and the mode never clobber each other. */
function writePersisted(patch: Persisted): void {
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	const next = { ...readPersisted(), ...patch };
	for (const k of Object.keys(next) as (keyof Persisted)[]) if (next[k] === undefined) delete next[k];
	writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
	try {
		chmodSync(CONFIG_FILE, 0o600);
	} catch {
		/* best effort */
	}
}

export function loadPersistedKey(): string | undefined {
	const { apiKey } = readPersisted();
	return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined;
}

export const persistKey = (key: string): void => writePersisted({ apiKey: key });
export const clearPersistedKey = (): void => writePersisted({ apiKey: undefined });

/** Persisted curation mode: "typesafe" (default) or "semif". */
export function loadPersistedMode(): string | undefined {
	const { mode } = readPersisted();
	return typeof mode === "string" ? mode : undefined;
}
export const persistMode = (mode: string): void => writePersisted({ mode });

/** Persisted SemIf model id (see semif.ts MODELS). */
export const loadPersistedModel = (): string | undefined => readPersisted().model;
export const persistModel = (model: string): void => writePersisted({ model });

export const loadLocalBaseUrl = (): string | undefined => readPersisted().localBaseUrl;
export const persistLocalBaseUrl = (localBaseUrl: string): void => writePersisted({ localBaseUrl });

export const loadUserSettings = (): UserSettings => {
	const settings = readPersisted().settings;
	return settings && typeof settings === "object" ? settings : {};
};
export const persistUserSettings = (patch: UserSettings): void =>
	writePersisted({ settings: { ...loadUserSettings(), ...patch } });

export function resolveApiKey(sessionKey: string | undefined): ApiKeyResolution {
	if (sessionKey) {
		return { key: sessionKey, source: "set via /jev-context-curator set-key (this session)" };
	}
	if (process.env.TYPESAFE_API_KEY) {
		return { key: process.env.TYPESAFE_API_KEY, source: "TYPESAFE_API_KEY env var" };
	}
	const persisted = loadPersistedKey();
	if (persisted) {
		return { key: persisted, source: "~/.pi/curator-jev.json" };
	}
	return { key: undefined, source: "none" };
}

/** Never log or display a full key — show only the last 4 chars. */
export function maskKey(key: string): string {
	return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
}
