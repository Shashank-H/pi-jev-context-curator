/** Session-scoped record of context units discarded by Jev. */

export interface RemovedContextEntry {
	fingerprint: string;
	label: string;
	text: string;
	reason?: string;
	messageCount: number;
	tokens: number;
	timestamp: number;
}

export class RemovedContextStore {
	private readonly entries = new Map<string, RemovedContextEntry>();

	/** Store each discarded unit once; returns true when it is new. */
	record(entry: Omit<RemovedContextEntry, "timestamp">): RemovedContextEntry | undefined {
		if (this.entries.has(entry.fingerprint)) return undefined;
		const stored = { ...entry, timestamp: Date.now() };
		this.entries.set(entry.fingerprint, stored);
		return stored;
	}

	/** Restore a previously persisted entry when resuming this session. */
	restore(entry: RemovedContextEntry): void {
		if (!this.entries.has(entry.fingerprint)) this.entries.set(entry.fingerprint, entry);
	}

	clear(): void {
		this.entries.clear();
	}

	get all(): readonly RemovedContextEntry[] {
		return [...this.entries.values()];
	}
}
