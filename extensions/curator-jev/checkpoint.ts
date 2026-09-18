/**
 * The judgment checkpoint.
 *
 * Every unit Jev has judged is recorded here by content fingerprint, mapped
 * to its keep/drop decision. On each `context` event, units already in the
 * checkpoint reuse their stored decision (no Jev call); only new units that
 * appeared after the checkpoint are sent to Jev. Each unit is therefore
 * judged exactly once per session.
 *
 * Cleared on `session_start` so judgments never leak across sessions.
 */
export class JudgmentCheckpoint {
	private readonly judged = new Map<string, boolean>();

	get(fingerprint: string): boolean | undefined {
		return this.judged.get(fingerprint);
	}

	record(fingerprint: string, keep: boolean): void {
		this.judged.set(fingerprint, keep);
	}

	clear(): void {
		this.judged.clear();
	}

	get judgedCount(): number {
		return this.judged.size;
	}
}
