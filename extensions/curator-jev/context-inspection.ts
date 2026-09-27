/** Session-scoped record of context units inspected by Jev. */

export interface ContextInspectionEntry {
	fingerprint: string;
	label: string;
	text: string;
	reason?: string;
	messageCount: number;
	tokens: number;
	timestamp: number;
	kept: boolean;
}

export class ContextInspectionStore {
	private readonly entries = new Map<string, ContextInspectionEntry>();

	/** Store each inspected unit once; returns true when it is new. */
	record(entry: Omit<ContextInspectionEntry, "timestamp">): ContextInspectionEntry | undefined {
		if (this.entries.has(entry.fingerprint)) return undefined;
		const stored = { ...entry, timestamp: Date.now() };
		this.entries.set(entry.fingerprint, stored);
		return stored;
	}

	/** Restore a previously persisted entry when resuming this session. */
	restore(entry: ContextInspectionEntry): void {
		if (!this.entries.has(entry.fingerprint)) this.entries.set(entry.fingerprint, entry);
	}

	clear(): void {
		this.entries.clear();
	}

	get all(): readonly ContextInspectionEntry[] {
		return [...this.entries.values()];
	}
}
