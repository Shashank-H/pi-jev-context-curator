/**
 * API key + setup preferences.
 *
 * Resolution order for the key:
 *   1. key set via `/jev-context-curator set-key` (current session only, in memory)
 *   2. `TYPESAFE_API_KEY` environment variable
 *   3. key persisted in `~/.pi/curator-jev.json` by a previous `set-key` or `setup`
 *
 * The same file also remembers the judge backend choice from `setup` /
 * `judge`, so curation keeps working across sessions without re-running setup.
 * Env vars (`CURATOR_JEV_JUDGE`, `CURATOR_JEV_CLASSIFIER_TIER`) override it.
 *
 * The persisted file is plaintext with mode 0600 — the same convention pi
 * itself uses for `~/.pi/agent/models.json`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClassifierTier, JudgeBackend } from "./config.ts";

export const CONFIG_FILE = join(homedir(), ".pi", "curator-jev.json");

export interface StoredPrefs {
	apiKey?: string;
	judge?: JudgeBackend;
	classifierTier?: ClassifierTier;
}

export interface ApiKeyResolution {
	key: string | undefined;
	source: string;
}

export function loadPrefs(): StoredPrefs {
	try {
		if (!existsSync(CONFIG_FILE)) return {};
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
		const prefs: StoredPrefs = {};
		if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) prefs.apiKey = raw.apiKey;
		if (raw.judge === "jev" || raw.judge === "classifier") prefs.judge = raw.judge;
		if (raw.classifierTier === "fast" || raw.classifierTier === "smart") {
			prefs.classifierTier = raw.classifierTier;
		}
		return prefs;
	} catch {
		return {};
	}
}

function writePrefs(prefs: StoredPrefs): void {
	mkdirSync(join(homedir(), ".pi"), { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify(prefs, null, 2) + "\n", { mode: 0o600 });
	try {
		chmodSync(CONFIG_FILE, 0o600);
	} catch {
		/* best effort */
	}
}

/** Merge prefs into the store, preserving everything else (e.g. the API key). */
export function savePrefs(prefs: StoredPrefs): void {
	writePrefs({ ...loadPrefs(), ...prefs });
}

export function loadPersistedKey(): string | undefined {
	return loadPrefs().apiKey;
}

export function persistKey(key: string): void {
	savePrefs({ apiKey: key });
}

export function clearPersistedKey(): void {
	const { apiKey: _dropped, ...rest } = loadPrefs();
	writePrefs(rest);
}

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
