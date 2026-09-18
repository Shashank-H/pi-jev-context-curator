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
import { join } from "node:path";

export const CONFIG_FILE = join(homedir(), ".pi", "curator-jev.json");

export interface ApiKeyResolution {
	key: string | undefined;
	source: string;
}

export function loadPersistedKey(): string | undefined {
	try {
		if (!existsSync(CONFIG_FILE)) return undefined;
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { apiKey?: unknown };
		return typeof raw.apiKey === "string" && raw.apiKey.length > 0 ? raw.apiKey : undefined;
	} catch {
		return undefined;
	}
}

export function persistKey(key: string): void {
	mkdirSync(join(homedir(), ".pi"), { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: key }, null, 2) + "\n", { mode: 0o600 });
	try {
		chmodSync(CONFIG_FILE, 0o600);
	} catch {
		/* best effort */
	}
}

export function clearPersistedKey(): void {
	try {
		writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2) + "\n", { mode: 0o600 });
	} catch {
		/* best effort */
	}
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
